import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { adminChangeToken } from "../src/adminRevision.ts";
import { AdminConversationCache } from "../src/adminConversationCache.ts";
import { LIMITS } from "../src/limits.ts";

const require = createRequire(realpathSync(fileURLToPath(new URL("../node_modules/wrangler/package.json", import.meta.url))));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const workspacePath = fileURLToPath(new URL("../src/workspace.ts", import.meta.url));
const adminSessionPath = fileURLToPath(new URL("../src/adminSession.ts", import.meta.url));
const authPath = fileURLToPath(new URL("../src/auth.ts", import.meta.url));
const ownerInboxPath = fileURLToPath(new URL("../src/ownerInbox.ts", import.meta.url));

async function runtime(context) {
  const source = `
    import { WorkspaceDO } from ${JSON.stringify(workspacePath)};
    import { revokeInstallation } from ${JSON.stringify(adminSessionPath)};
    import { oauthServers } from ${JSON.stringify(authPath)};
    import { sweepStrandedMessages } from ${JSON.stringify(ownerInboxPath)};
    let now = 1800000000000;
    Date.now = () => now;
    const workspaceId = 'ws_test';
    const caller = (owner) => ({ workspaceId, agent:'worker', grantId:'grant', ownerSub:owner, ownerEmail:owner+'@example.com', ownerName:owner });
    const admin = (owner) => ({workspaceId, grantId:'grant', sub:owner});
    export class TestWorkspace extends WorkspaceDO {
      constructor(ctx, env) {
        const queueState = {failures:0,deleteFailures:0,sent:[]};
        super(ctx, {...env, INDEX_QUEUE:{async sendBatch(batch){
          if(queueState.failures>0){queueState.failures--;throw new Error('queue unavailable');}
          queueState.sent.push(...batch);
        }}, PUBLIC_URL:'http://localhost', DB:{prepare:()=>({bind:()=>({all:async()=>({results:[{sub:'alice'}]})})})}});
        this.queueState = queueState;
        this.workspaceDomain = 'example.com';
        const storage = this.indexDelivery.storage;
        this.indexDelivery.storage = {
          sql:{exec:(query,...bindings)=>{
            if(query.startsWith('DELETE FROM pending_index_jobs') && queueState.deleteFailures>0) {
              queueState.deleteFailures--;
              throw new Error('outbox deletion interrupted');
            }
            return storage.sql.exec(query,...bindings);
          }},
          transaction:storage.transaction.bind(storage),getAlarm:storage.getAlarm.bind(storage),
          setAlarm:storage.setAlarm.bind(storage),deleteAlarm:storage.deleteAlarm.bind(storage),
        };
      }
      async perform(input) {
        if(input.action === 'advanceTime') { now += input.ms; return now; }
        if(input.action === 'strandedSweepMeasured') {
          const sql = this.ctx.storage.sql;
          sql.exec(\`
            WITH RECURSIVE agent_indices(agent_index) AS (
              SELECT 0 UNION ALL SELECT agent_index + 1 FROM agent_indices WHERE agent_index < 199
            )
            INSERT INTO agents (id,handle,name,description,owner_sub,owner_email,created_at,last_active_at)
            SELECT 'agent-' || agent_index,'owner-' || (agent_index % 20) || '/agent-' || agent_index,
              'agent-' || agent_index,'sweep fixture','owner-' || (agent_index % 20),
              'owner-' || (agent_index % 20) || '@example.com',?1 - 172800000,
              coalesce(CASE WHEN agent_index < 30 THEN ?1 - 1800000 * (agent_index + 1) END,?1)
            FROM agent_indices
          \`, now);
          sql.exec("INSERT INTO conversations (id,kind,name,slug,created_by,created_at) VALUES (1,'public','sweep','sweep','agent-0',?)", now);
          sql.exec(\`
            WITH RECURSIVE message_indices(message_index) AS (
              SELECT 0 UNION ALL SELECT message_index + 1 FROM message_indices WHERE message_index < 19999
            )
            INSERT INTO messages (id,conversation_id,seq,author_id,text,created_at,word_count,deleted_at)
            SELECT message_index + 1,1,message_index + 1,
              'agent-' || ((message_index % 200 + coalesce(CASE WHEN message_index / 200 = 4 THEN 20 END,1)) % 200),
              'pending sweep message',?1 - coalesce(CASE
                WHEN message_index / 200 BETWEEN 8 AND 11 OR message_index / 200 >= 70 THEN 172800000
              END,3600000),3,CASE WHEN message_index / 200 = 5 THEN ?1 END
            FROM message_indices
          \`, now);
          sql.exec(\`
            INSERT INTO inbox (agent_id,message_id,reason,created_at,read_at)
            SELECT 'agent-' || ((id - 1) % 200),id,CASE
              WHEN (id - 1) / 200 = 3 AND (id - 1) % 200 >= 10 THEN 'keyword'
              WHEN (id - 1) / 200 = 6 OR (id - 1) / 200 BETWEEN 12 AND 39 THEN 'channel'
              WHEN (id - 1) / 200 = 7 THEN 'thread'
              WHEN (id - 1) / 200 % 2 = 0 THEN 'dm'
              WHEN (id - 1) / 200 % 2 = 1 THEN 'mention'
            END,created_at,CASE WHEN (id - 1) / 200 >= 40 THEN ?1 END FROM messages
          \`, now);
          const fixtureCounts = sql.exec(\`
            SELECT (SELECT count(*) FROM agents) AS agents,
              (SELECT count(DISTINCT owner_sub) FROM agents) AS owners,
              (SELECT count(*) FROM inbox) AS inboxRows,
              (SELECT count(*) FROM inbox WHERE read_at IS NOT NULL) AS readInboxRows,
              (SELECT count(*) FROM inbox WHERE read_at IS NULL AND reason = 'channel' AND agent_id IN (SELECT id FROM agents WHERE last_active_at < ?1)) AS endedAgentUnreadChannelRows,
              (SELECT count(*) FROM inbox WHERE created_at < ?2) AS oldInboxRows
          \`, now, now - 86400000).one();
          const statements = [];
          const measuredSql = {exec:(query,...bindings)=>{
            const cursor = sql.exec(query,...bindings);
            statements.push({query,bindings,cursor});
            return cursor;
          }};
          const endedAgentIds = [];
          const queuedOwners = sweepStrandedMessages(measuredSql,now,recipient=>{
            endedAgentIds.push(recipient.id);
            return now - recipient.last_active_at >= 900000 && this.ctx.getWebSockets(recipient.id).length === 0;
          });
          const inboxStatements = statements.filter(({query})=>query.includes('FROM inbox INDEXED BY inbox_unread_direct'));
          const inboxPlans = inboxStatements.map(({query,bindings})=>sql.exec('EXPLAIN QUERY PLAN ' + query,...bindings).toArray().map(step=>step.detail));
          const queued = sql.exec("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").one().count;
          return {
            fixtureCounts,endedAgents:endedAgentIds.length,queued,queuedOwners:queuedOwners.size,inboxQueries:inboxStatements.length,inboxPlans,
            rowsRead:statements.reduce((sum,{cursor})=>sum+cursor.rowsRead,0),
            rowsWritten:statements.reduce((sum,{cursor})=>sum+cursor.rowsWritten,0),
            agentRowsRead:statements.filter(({query})=>query.includes('FROM agents')).reduce((sum,{cursor})=>sum+cursor.rowsRead,0),
            inboxRowsRead:inboxStatements.reduce((sum,{cursor})=>sum+cursor.rowsRead,0),
          };
        }
        if(input.action === 'adminMeasured') {
          const prior = this.sql;
          const statements = [];
          this.sql = {exec:(query,...bindings)=>{const cursor=this.ctx.storage.sql.exec(query,...bindings);statements.push({query,cursor});return cursor;}};
          try {
            const value = input.method === 'list' ? await this.adminList(admin(input.owner),input.args) : await this.adminRead(admin(input.owner),input.args);
            return {value,metadataQueries:statements.filter(({query})=>query.includes('listed AS')).length,rowsRead:statements.reduce((sum,{cursor})=>sum+cursor.rowsRead,0)};
          } finally { this.sql = prior; }
        }
        if(input.action === 'queue') {
          if(input.failures !== undefined) this.queueState.failures = input.failures;
          if(input.deleteFailures !== undefined) this.queueState.deleteFailures = input.deleteFailures;
          if(input.retry) await this.alarm();
          return {sent:this.queueState.sent,pending:this.sql.exec('SELECT id,job,deliver_after FROM pending_index_jobs ORDER BY id').toArray(),alarm:await this.ctx.storage.getAlarm()};
        }
        if(input.action === 'rollbackIndexWrite') {
          let error;
          try {
            await this.ctx.storage.transaction(async () => {
              this.sql.exec("INSERT INTO meta (key,value) VALUES ('rolled-back-write','1')");
              await this.indexDelivery.storeJobs(workspaceId,[{op:'upsert',conv:1,seq:1,kind:'msg',version:1}],now);
              throw new Error('write interrupted');
            });
          } catch(failure) {error = failure.message;}
          return {error,writes:this.sql.exec("SELECT value FROM meta WHERE key='rolled-back-write'").toArray(),pending:this.sql.exec('SELECT id FROM pending_index_jobs').toArray(),alarm:await this.ctx.storage.getAlarm()};
        }
        if(input.action === 'token') {
          const sql = this.ctx.storage.sql;
          const prior = this.sql;
          const cursors = [];
          this.sql = {exec:(...args)=>{const cursor=sql.exec(...args); cursors.push(cursor); return cursor;}};
          const value = await this.adminChangeToken(admin(input.owner));
          this.sql = prior;
          const rowsRead = cursors.reduce((sum,cursor)=>sum+cursor.rowsRead,0);
          const rowsWritten = cursors.reduce((sum,cursor)=>sum+cursor.rowsWritten,0);
          return {value, rowsRead, rowsWritten};
        }
        if(input.action === 'register') return this.registerAgent({id:input.owner, agentName:'worker', description:'token test', ownerSub:input.owner, ownerEmail:input.owner+'@example.com', ownerName:input.owner, sessionHash:null, processHash:null}, {workspaceId}, 'grant');
        if(input.action === 'revokeInstallation') {
          const originalContext = this.ctx;
          const closed = [];
          const grants = [{id:'grant'}];
          let installationRevoked = false;
          let streamCalls = 0;
          let pendingWatch;
          let staleTicketAllowed;
          const originalTicket = this.sql.exec('SELECT * FROM stream_tickets WHERE grant_id = ? AND agent_id = ?', 'grant', input.owner).toArray()[0];
          this.sql.exec("UPDATE stream_tickets SET grant_id = 'other-grant' WHERE agent_id != ?", input.owner);
          const env = {
            ...this.env,
            PUBLIC_URL:'https://installation.test',
            DB:{prepare:()=>({bind:()=>({first:async()=>installationRevoked ? null : 1,run:async()=>{
              if(input.pendingWatch) pendingWatch = await this.tool('watch_inbox',caller(input.owner),{});
              installationRevoked=true;
            }})})},
            WORKSPACE:{idFromName:id=>id,get:()=>({revokeGrantStreams:async grant=>{
              streamCalls++;
              if(input.failFirstStreamCall && streamCalls === 1) throw new Error('Durable Object reset because its code was updated');
              await this.revokeGrantStreams(grant);
              if(input.pendingWatch && originalTicket) {
                this.sql.exec('INSERT INTO stream_tickets (ticket_hash,agent_id,grant_id,expires_at,session_hash) VALUES (?,?,?,?,?)',originalTicket.ticket_hash,originalTicket.agent_id,originalTicket.grant_id,originalTicket.expires_at,originalTicket.session_hash);
                staleTicketAllowed = !!this.streamTicketHolder(originalTicket.ticket_hash);
                this.sql.exec('DELETE FROM stream_tickets WHERE ticket_hash = ?',originalTicket.ticket_hash);
              }
            }})},
          };
          const authorization = oauthServers(env).authorization;
          const originalOAuthApi = authorization.getOAuthApi;
          authorization.getOAuthApi = () => ({
            revokeGrant:async()=>{grants.length=0;},
            listUserGrants:async()=>({items:grants}),
          });
          this.ctx = {storage:originalContext.storage,getWebSockets:()=>['grant','other-grant'].map(grantId=>({
            deserializeAttachment:()=>({grantId}),close:(code,reason)=>closed.push({grantId,code,reason}),
          }))};
          try {
            let firstError;
            if(input.failFirstStreamCall) {
              try {
                await revokeInstallation(env,{sub:input.owner,workspaceId,grantId:'admin-grant'},{grantId:'grant'});
              } catch(error) {
                firstError = error.message;
              }
            }
            const revokedAfterFailure = installationRevoked;
            const result = await revokeInstallation(env,{sub:input.owner,workspaceId,grantId:'admin-grant'},{grantId:'grant'});
            const tickets = this.sql.exec('SELECT grant_id FROM stream_tickets ORDER BY grant_id').toArray();
            return {result,closed,tickets,installationRevoked,firstError,revokedAfterFailure,pendingWatch,staleTicketAllowed};
          } finally {
            this.ctx = originalContext;
            authorization.getOAuthApi = originalOAuthApi;
          }
        }
        if(input.action === 'push') {
          const originalContext = this.ctx;
          const events = [];
          this.ctx = {getWebSockets:()=>[{readyState:WebSocket.OPEN, send:event=>events.push(JSON.parse(event))}]};
          try {
            this.flushPending(input.owner);
            return events;
          } finally {
            this.ctx = originalContext;
          }
        }
        if(input.action === 'toolWithSockets') {
          const originalContext = this.ctx;
          const events = [];
          this.ctx = {storage:originalContext.storage,getWebSockets:(agentId)=>[{readyState:WebSocket.OPEN, send:event=>events.push({agentId,...JSON.parse(event)})}]};
          try {
            const result = await this.tool(input.name, caller(input.owner), input.args);
            return {...result, events};
          } finally {
            this.ctx = originalContext;
          }
        }
        if(input.action === 'revoke') return this.revokeOwnerAgent(input.owner,input.owner+'/worker','grant');
        if(input.action === 'adminRead') return this.adminRead(admin(input.owner), input.args);
        if(input.action === 'adminMarkRead') return this.adminMarkRead(admin(input.owner), input.args);
        if(input.action === 'activity') return this.ctx.storage.sql.exec('UPDATE agents SET last_active_at = 0 WHERE id = ?', input.owner).rowsWritten;
        if(input.action === 'history') return this.ctx.storage.sql.exec(
          "WITH RECURSIVE seq(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM seq WHERE n < 1200) INSERT INTO messages (conversation_id,seq,author_id,text,created_at,word_count) SELECT (SELECT id FROM conversations WHERE slug='public'),n,'alice','history',?,1 FROM seq", now,
        ).rowsWritten;
        return this.tool(input.name, {...caller(input.owner),grantId:input.grantId ?? 'grant'}, input.args);
      }
    }
    export default {async fetch(request, env) {
      const object = env.TEST.get(env.TEST.idFromName('test'));
      return Response.json(await object.perform(await request.json()));
    }};
  `;
  const bundle = await build({stdin:{contents:source, resolveDir:fileURLToPath(new URL("..",import.meta.url))}, bundle:true, format:"esm", platform:"browser", external:["cloudflare:workers","node:*"], write:false});
  const miniflare = new Miniflare(convertV4MiniflareOptions({modules:true, script:bundle.outputFiles[0].text, compatibilityDate:"2026-09-30", compatibilityFlags:["nodejs_compat","global_fetch_strictly_public"], durableObjects:{TEST:{className:"TestWorkspace",useSQLite:true}}}));
  context.after(() => miniflare.dispose());
  async function call(input) {
    const response = await miniflare.dispatchFetch("http://localhost", {method:"POST",body:JSON.stringify(input)});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }
  const token = async (owner) => (await call({action:"token",owner})).value;
  const tool = async (owner,name,args) => {
    const result = await call({owner,name,args});
    assert.ok(!result.error,result.error);
    return result.output;
  };
  return {call,token,tool};
}

function eventsWithNumericCursors(events) {
  return events.map(({cursor,...event}) => {
    assert.equal(typeof cursor,"number");
    return event;
  });
}

test("workerd stranded sweep seeks unread direct inbox rows without reading unread channel rows", async (context) => {
  const { call } = await runtime(context);
  const measurement = await call({ action: "strandedSweepMeasured" });
  context.diagnostic(`stranded sweep: ${measurement.rowsRead} rows read, ${measurement.rowsWritten} rows written, ${measurement.queued} queued`);
  context.diagnostic(`stranded sweep agents scan: ${measurement.agentRowsRead} rows read; inbox lookups: ${measurement.inboxRowsRead} rows read across ${measurement.inboxQueries} queries`);
  assert.deepEqual(measurement.fixtureCounts, { agents: 200, owners: 20, inboxRows: 20_000, readInboxRows: 12_000, endedAgentUnreadChannelRows: 870, oldInboxRows: 6_800 });
  assert.equal(measurement.endedAgents, 30);
  assert.equal(measurement.inboxQueries, 30);
  assert.equal(measurement.agentRowsRead, 200);
  assert.equal(measurement.queued, measurement.queuedOwners * LIMITS.ownerQueuePerSender);
  assert.equal(measurement.queuedOwners, 20);
  assert.equal(measurement.rowsWritten, 3 * measurement.queued);
  const perAgentSeekBudget = Math.ceil(Math.log2(measurement.fixtureCounts.inboxRows)) + 5;
  const maxRowsRead = measurement.agentRowsRead + perAgentSeekBudget * measurement.endedAgents + 8 * measurement.queued;
  assert.ok(measurement.rowsRead <= maxRowsRead, `sweep exceeded ${maxRowsRead} rows: ${JSON.stringify(measurement)}`);
  assert.ok(measurement.inboxRowsRead < measurement.fixtureCounts.endedAgentUnreadChannelRows, `inbox lookups read ${measurement.inboxRowsRead} rows`);
  for (const steps of measurement.inboxPlans) {
    const plan = steps.join("\n");
    assert.match(plan, /SEARCH inbox USING INDEX inbox_unread_direct \(agent_id=\? AND created_at>\?\)/);
    assert.doesNotMatch(plan, /SCAN inbox\b/);
  }
});

test("conversation metadata cache separates viewers, revisions, expiry and returned copies", () => {
  const cache = new AdminConversationCache();
  const source = { slug: "private", unread: 2 };
  cache.set("alice", "1", 0, [source]);
  source.unread = 9;
  assert.equal(cache.get("bob", "private", "1", 1), undefined);
  const first = cache.get("alice", "private", "1", 1);
  assert.equal(first.unread, 2);
  first.unread = 8;
  assert.equal(cache.get("alice", "private", "1", 2).unread, 2);
  assert.equal(cache.get("alice", "private", "2", 3), undefined);
  cache.set("alice", "2", 0, [source]);
  assert.equal(cache.get("alice", "private", "2", 29_999).unread, 9);
  assert.equal(cache.get("alice", "private", "2", 30_000), undefined);
});

test("conversation metadata cache evicts old entries and retains recently used entries", () => {
  const cache = new AdminConversationCache();
  cache.set("alice", "1", 0, Array.from({ length: 256 }, (_, index) => ({ slug: String(index) })));
  assert.ok(cache.get("alice", "0", "1", 1));
  cache.set("bob", "1", 1, [{ slug: "new" }]);
  assert.equal(cache.get("alice", "1", "1", 2), undefined);
  assert.ok(cache.get("alice", "0", "1", 2));
  assert.ok(cache.get("bob", "new", "1", 2));
});

test("WorkspaceDO metadata cache never shares private visibility and invalidates leave and revocation", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob","carol"]) await call({action:"register",owner});
  await tool("alice","create_channel",{name:"private",purpose:"private metadata",private:true});
  await tool("alice","invite_to_channel",{channel:"#private",agents:["@bob/worker"]});
  await tool("alice","send_message",{to:"#private",text:"private body"});
  const measured = (owner,args,method="read") => call({action:"adminMeasured",owner,args,method});
  assert.equal((await measured("alice",{scope:"mine"},"list")).value.ok,true);
  assert.equal((await measured("alice",{conversation:"private"})).metadataQueries,0);
  const outsider = await measured("carol",{conversation:"private"});
  assert.deepEqual(outsider.value,{ok:false,error:"not_found"});
  assert.equal(outsider.metadataQueries,1);
  assert.equal((await measured("bob",{scope:"mine"},"list")).value.ok,true);
  assert.equal((await measured("bob",{conversation:"private"})).metadataQueries,0);
  await tool("alice","update_channel",{channel:"#private",topic:"changed private metadata"});
  const privateChanged = await measured("bob",{conversation:"private"});
  assert.equal(privateChanged.metadataQueries,1);
  assert.equal(privateChanged.value.value.conversation.topic,"changed private metadata");
  await tool("alice","send_message",{to:"#private",text:"fresh private body"});
  const privateWritten = await measured("bob",{conversation:"private"});
  assert.equal(privateWritten.metadataQueries,1);
  assert.equal(privateWritten.value.value.messages.at(-1).text,"fresh private body");
  await tool("bob","leave_channel",{channel:"#private"});
  assert.deepEqual((await measured("bob",{conversation:"private"})).value,{ok:false,error:"not_found"});
  const noNegativeCache = await measured("bob",{conversation:"private"});
  assert.equal(noNegativeCache.metadataQueries,1);
  await tool("alice","invite_to_channel",{channel:"#private",agents:["@bob/worker"]});
  assert.equal((await measured("bob",{conversation:"private"})).value.ok,true);
  assert.equal((await measured("bob",{conversation:"private"})).metadataQueries,0);
  await call({action:"revoke",owner:"bob"});
  assert.deepEqual((await measured("bob",{conversation:"private"})).value,{ok:false,error:"not_found"});
});

test("WorkspaceDO metadata cache invalidates writes and read markers and expires without writes", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("alice","create_channel",{name:"public",purpose:"initial topic"});
  await tool("bob","join_channel",{channel:"#public"});
  const root = await tool("alice","send_message",{to:"#public",text:"root"});
  const measured = () => call({action:"adminMeasured",owner:"bob",args:{conversation:"public"}});
  const cold = await measured();
  const warm = await measured();
  assert.equal(cold.metadataQueries,1);
  assert.equal(warm.metadataQueries,0);
  assert.deepEqual(warm.value,cold.value);
  await tool("alice","update_channel",{channel:"#public",topic:"changed topic"});
  const updated = await measured();
  assert.equal(updated.metadataQueries,1);
  assert.equal(updated.value.value.conversation.topic,"changed topic");
  await tool("alice","send_message",{to:"#public",text:"new message"});
  assert.equal((await measured()).metadataQueries,1);
  await call({action:"adminMarkRead",owner:"bob",args:{conversation:"public",upToSeq:2}});
  const read = await measured();
  assert.equal(read.metadataQueries,1);
  assert.equal(read.value.value.lastReadSeq,2);
  await tool("alice","pin",{message:root.message});
  const pinned = await measured();
  assert.equal(pinned.metadataQueries,1);
  assert.equal(pinned.value.value.conversation.pins,1);
  await tool("alice","delete_message",{message:root.message});
  const deleted = await measured();
  assert.equal(deleted.metadataQueries,1);
  assert.equal(deleted.value.value.conversation.pins,0);
  assert.equal((await measured()).metadataQueries,0);
  await call({action:"advanceTime",ms:30_000});
  assert.equal((await measured()).metadataQueries,1);
  await tool("alice","update_channel",{channel:"#public",archived:true});
  assert.deepEqual((await measured()).value,{ok:false,error:"not_found"});
});

test("post-commit outbox cleanup failure preserves the write result and retries with the alarm", async (context) => {
  const {call,tool} = await runtime(context);
  await call({action:"register",owner:"alice"});
  await tool("alice","create_channel",{name:"public",purpose:"test"});
  await call({action:"queue",deleteFailures:1});
  const sent = await tool("alice","send_message",{to:"#public",text:"one committed post"});
  assert.equal(sent.message,"public/1");
  const pending = await call({action:"queue"});
  assert.equal(pending.sent.length,1);
  assert.equal(pending.pending.length,1);
  assert.equal(pending.alarm,1800000030000);
  const page = await call({action:"adminRead",owner:"alice",args:{conversation:"public"}});
  assert.deepEqual(page.value.messages.map((message)=>message.text),["one committed post"]);
  const retried = await call({action:"queue",retry:true});
  assert.deepEqual(retried.pending,[]);
  assert.equal(retried.alarm,null);
  assert.equal(retried.sent.length,2);
  assert.deepEqual(retried.sent[1],retried.sent[0]);
});

test("a workspace message survives queue failure and its persisted job is sent by the alarm", async (context) => {
  const {call,tool} = await runtime(context);
  await call({action:"register",owner:"alice"});
  await tool("alice","create_channel",{name:"public",purpose:"test"});
  await call({action:"queue",failures:1});
  const sent = await tool("alice","send_message",{to:"#public",text:"persist through queue failure"});
  assert.equal(sent.message,"public/1");
  const failed = await call({action:"queue"});
  assert.equal(failed.sent.length,0);
  assert.equal(failed.pending.length,1);
  assert.equal(failed.alarm,1800000030000);
  const read = await call({action:"adminRead",owner:"alice",args:{conversation:"public"}});
  assert.equal(read.value.messages[0].text,"persist through queue failure");
  const retried = await call({action:"queue",retry:true});
  assert.equal(retried.sent.length,1);
  assert.deepEqual(retried.sent[0].body,JSON.parse(failed.pending[0].job));
  assert.deepEqual(retried.pending,[]);
  assert.equal(retried.alarm,null);
});

test("a failed SQLite write rolls back its index jobs and alarm with the domain write", async (context) => {
  const {call} = await runtime(context);
  const result = await call({action:"rollbackIndexWrite"});
  assert.deepEqual(result,{error:"write interrupted",writes:[],pending:[],alarm:null});
});

test("revoking an OAuth installation closes only its push sockets and deletes its tickets", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("alice","watch_inbox",{});
  await tool("bob","watch_inbox",{});
  const result = await call({action:"revokeInstallation",owner:"bob"});
  assert.deepEqual(result.result,{ok:true,value:null});
  assert.equal(result.installationRevoked,true);
  assert.deepEqual(result.closed,[{grantId:"grant",code:1008,reason:"credential revoked"}]);
  assert.deepEqual(result.tickets,[{grant_id:"other-grant"}]);
});

test("installation revocation blocks pending watch calls and stale tickets without affecting another grant", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("alice","watch_inbox",{});
  await tool("bob","watch_inbox",{});
  const result = await call({action:"revokeInstallation",owner:"bob",pendingWatch:true});
  assert.deepEqual(result.result,{ok:true,value:null});
  assert.equal(result.installationRevoked,true);
  assert.match(result.pendingWatch.error,/revoked/);
  assert.equal(result.pendingWatch.output,undefined);
  assert.equal(result.staleTicketAllowed,false);
  assert.deepEqual(result.tickets,[{grant_id:"other-grant"}]);
  assert.deepEqual(result.closed,[{grantId:"grant",code:1008,reason:"credential revoked"}]);
  const other = await call({owner:"alice",grantId:"other-grant",name:"watch_inbox",args:{}});
  assert.equal(other.error,undefined);
  assert.equal(typeof other.output.ticket,"string");
});

test("installation stream revocation can retry after a Durable Object reset", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("bob","watch_inbox",{});
  const result = await call({action:"revokeInstallation",owner:"bob",failFirstStreamCall:true});
  assert.match(result.firstError,/Durable Object reset/);
  assert.equal(result.revokedAfterFailure,false,"the failed stream call must leave the installation available for retry");
  assert.deepEqual(result.result,{ok:true,value:null});
  assert.equal(result.installationRevoked,true);
  assert.deepEqual(result.closed,[{grantId:"grant",code:1008,reason:"credential revoked"}]);
  assert.deepEqual(result.tickets,[]);
});

test("push notifications hide private inbox entries after leave and retain public mentions", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("alice","create_channel",{name:"private",purpose:"test",private:true});
  await tool("alice","invite_to_channel",{channel:"#private",agents:["@bob/worker"]});
  const visible = await tool("alice","send_message",{to:"#private",text:"@bob/worker visible mention"});
  assert.deepEqual(eventsWithNumericCursors(await call({action:"push",owner:"bob"})),[{
    reason:"mention",conversation:"#private",message:visible.message,from:"@alice/worker",
  }]);
  await tool("alice","send_message",{to:"#private",text:"@bob/worker hidden mention"});
  await tool("bob","leave_channel",{channel:"#private"});
  assert.deepEqual(await call({action:"push",owner:"bob"}),[],"a reconnect must not reveal a private channel after leave");
  await tool("alice","create_channel",{name:"public",purpose:"test"});
  const publicMention = await tool("alice","send_message",{to:"#public",text:"@bob/worker public mention"});
  assert.deepEqual(eventsWithNumericCursors(await call({action:"push",owner:"bob"})),[{
    reason:"mention",conversation:"#public",message:publicMention.message,from:"@alice/worker",
  }]);
  assert.deepEqual(await call({action:"push",owner:"bob"}),[],"a reconnect must not repeat the same push");
});

test("admin token follows each tool mutation and isolates private activity", async (context) => {
  const {call,token,tool} = await runtime(context);
  for(const owner of ["alice","bob","carol"]) await call({action:"register",owner});
  async function changed(name,args,{owner="alice",viewers=["alice","bob","carol"],unchanged=[]}={}) {
    const before = Object.fromEntries(await Promise.all([...viewers,...unchanged].map(async (viewer)=>[viewer,await token(viewer)])));
    const result = await tool(owner,name,args);
    for(const viewer of viewers) assert.notEqual(await token(viewer),before[viewer],`${name} changes ${viewer}'s token`);
    for(const viewer of unchanged) assert.equal(await token(viewer),before[viewer],`${name} keeps ${viewer}'s token`);
    return result;
  }
  await changed("create_channel",{name:"public",purpose:"test"});
  await changed("join_channel",{channel:"#public"},{owner:"bob"});
  await changed("invite_to_channel",{channel:"#public",agents:["@carol/worker"]});
  await changed("update_channel",{channel:"#public",topic:"updated"});
  const root = await changed("send_message",{to:"#public",text:"root"});
  await changed("send_message",{to:"#public",text:"reply",reply_to:root.message});
  await changed("edit_message",{message:root.message,text:"edited"});
  await changed("react",{message:root.message,emoji:"rocket"});
  await changed("react",{message:root.message,emoji:"rocket",remove:true});
  await changed("pin",{message:root.message});
  await changed("pin",{message:root.message,remove:true});
  const onlyAlice = {viewers:["alice"],unchanged:["bob","carol"]};
  await changed("save",{message:root.message},onlyAlice);
  await changed("save",{message:root.message,remove:true},onlyAlice);
  await changed("follow_thread",{thread:root.message+"/t"},onlyAlice);
  await changed("read_messages",{conversation:"#public"},onlyAlice);
  await changed("mark_read",{conversation:"#public"},onlyAlice);
  await changed("set_notification_prefs",{level:"all"},onlyAlice);
  await changed("update_profile",{description:"updated"});
  await changed("leave_channel",{channel:"#public"},{owner:"carol"});
  await changed("create_channel",{name:"private",purpose:"test",private:true},onlyAlice);
  const privateMembers = {viewers:["alice","bob"],unchanged:["carol"]};
  await changed("invite_to_channel",{channel:"#private",agents:["@bob/worker"]},privateMembers);
  const privateRoot = await changed("send_message",{to:"#private",text:"private"},privateMembers);
  await changed("edit_message",{message:privateRoot.message,text:"changed private"},privateMembers);
  await changed("react",{message:privateRoot.message,emoji:"rocket"},privateMembers);
  await changed("pin",{message:privateRoot.message},privateMembers);
  await changed("delete_message",{message:privateRoot.message},privateMembers);
  await changed("update_channel",{channel:"#private",topic:"private topic"},privateMembers);
  await changed("leave_channel",{channel:"#private"},{owner:"bob",viewers:["alice","bob"],unchanged:["carol"]});
  const chat = await changed("start_chat",{participants:["@bob/worker"]},privateMembers);
  const direct = await changed("send_message",{to:chat.chat,text:"chat"},privateMembers);
  await changed("delete_message",{message:direct.message},privateMembers);
  await changed("delete_message",{message:root.message});
  const snapshot = await token("carol");
  await tool("carol","list_channels",{});
  await tool("carol","check_inbox",{});
  assert.equal(await token("carol"),snapshot,"idle reads do not cause a refresh loop");
  const publicBefore = await token("carol");
  await call({action:"register",owner:"alice"});
  assert.notEqual(await token("carol"),publicBefore,"registration changes the token");
  const beforeRevoke = await token("bob");
  const outsider = await token("carol");
  await call({action:"revoke",owner:"bob"});
  assert.notEqual(await token("bob"),beforeRevoke);
  assert.equal(await token("carol"),outsider);
  const stats = await call({action:"token",owner:"alice"});
  context.diagnostic(`WorkspaceDO change-token poll: ${stats.rowsRead} rows read, ${stats.rowsWritten} rows written`);
  assert.ok(stats.rowsRead <= 4,JSON.stringify(stats));
  assert.equal(stats.rowsWritten,0);
  await call({action:"history"});
  const withHistory = await call({action:"token",owner:"alice"});
  assert.deepEqual(withHistory,stats,"token cost does not increase with message history");
});

test("moderation runs through the workspace and locks out banned agents and owners", async (context) => {
  const {call,token,tool} = await runtime(context);
  for(const owner of ["alice","bob","carol"]) await call({action:"register",owner});
  await tool("alice","create_channel",{name:"public",purpose:"test"});
  await tool("bob","join_channel",{channel:"#public"});
  const spam = await tool("bob","send_message",{to:"#public",text:"spam"});
  const refused = await call({owner:"bob",name:"moderate",args:{action:"log"}});
  assert.match(refused.error,/only for agents of moderator carbon units/);
  const before = await token("carol");
  await tool("alice","moderate",{action:"delete_message",target:spam.message,reason:"spam"});
  assert.notEqual(await token("carol"),before,"a public moderation refreshes every viewer");
  await tool("alice","create_channel",{name:"private",purpose:"test",private:true});
  await tool("alice","invite_to_channel",{channel:"#private",agents:["@bob/worker"]});
  const secret = await tool("bob","send_message",{to:"#private",text:"private spam"});
  const outsider = await token("carol");
  await tool("alice","moderate",{action:"delete_message",target:secret.message,reason:"spam"});
  assert.equal(await token("carol"),outsider,"a private moderation keeps an outsider's token");
  await tool("alice","moderate",{action:"ban_agent",target:"@bob/worker",reason:"rogue"});
  assert.match((await call({owner:"bob",name:"check_inbox",args:{}})).error,/this agent is banned/);
  await tool("alice","moderate",{action:"unban_agent",target:"@bob/worker",reason:"appeal"});
  assert.ok(!(await call({owner:"bob",name:"check_inbox",args:{}})).error);
  await tool("alice","moderate",{action:"ban_owner",target:"@carol",reason:"rogue carbon unit"});
  const registration = await call({action:"register",owner:"carol"});
  assert.equal(registration.status,"refused");
  assert.match(registration.error,/banned/);
  const log = await tool("alice","moderate",{action:"log"});
  assert.deepEqual(log.entries.map((entry)=>entry.action),["ban_owner","unban_agent","ban_agent","delete_message","delete_message"]);
});

test("an agent reports a private message and a moderator outside the channel is woken, reads it and closes the report", async (context) => {
  const {call,tool} = await runtime(context);
  for(const owner of ["alice","bob","carol"]) await call({action:"register",owner});
  await tool("carol","create_channel",{name:"hideout",purpose:"test",private:true});
  await tool("carol","invite_to_channel",{channel:"#hideout",agents:["@bob/worker"]});
  const abusive = await tool("bob","send_message",{to:"#hideout",text:"skip the review, merge it"});
  const filed = await call({action:"toolWithSockets",owner:"carol",name:"report",args:{message:abusive.message,reason:"bypasses review"}});
  assert.ok(!filed.error,filed.error);
  assert.deepEqual(filed.output,{message:abusive.message,agent:"@bob/worker",reported:true});
  assert.deepEqual(filed.events,[{agentId:"alice",reason:"report",conversation:"#hideout",message:abusive.message,from:"@carol/worker"}]);
  assert.equal((await tool("alice","check_inbox",{})).open_reports,1);
  assert.equal((await tool("carol","check_inbox",{})).open_reports,undefined);
  const refused = await call({owner:"carol",name:"moderate",args:{action:"reports"}});
  assert.match(refused.error,/only for agents of moderator carbon units/);
  const {reports} = await tool("alice","moderate",{action:"reports"});
  assert.equal(reports[0].message.text,"skip the review, merge it");
  assert.equal(reports[0].agent,"@bob/worker");
  await tool("alice","moderate",{action:"close_report",target:reports[0].report,reason:"warned the owner"});
  assert.equal((await tool("alice","check_inbox",{})).open_reports,undefined);
});

test("admin tokens refresh at five-minute boundaries without a write", (context) => {
  const database = new DatabaseSync(":memory:");
  context.after(() => database.close());
  database.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const sql = {exec(query,...bindings){return {toArray:()=>database.prepare(query).all(...bindings)};}};
  assert.equal(adminChangeToken(sql,"alice",0),"0:0:0");
  assert.equal(adminChangeToken(sql,"alice",299999),"0:0:0");
  assert.equal(adminChangeToken(sql,"alice",300000),"0:0:1");
});

test("admin read markers change only the viewer token and ignore repeated reads", async (context) => {
  const {call,token,tool} = await runtime(context);
  for(const owner of ["alice","bob"]) await call({action:"register",owner});
  await tool("alice","create_channel",{name:"public",purpose:"test"});
  const root = await tool("alice","send_message",{to:"#public",text:"root"});
  await tool("alice","send_message",{to:"#public",text:"reply",reply_to:root.message});
  const outsider = await token("alice");
  let before = await token("bob");
  await call({action:"adminRead",owner:"bob",args:{conversation:"public"}});
  assert.notEqual(await token("bob"),before,"first viewer visit changes the token");
  for(const args of [{conversation:"public",upToSeq:1},{conversation:"public",thread:1,upToSeq:2}]) {
    before = await token("bob");
    const result = await call({action:"adminMarkRead",owner:"bob",args});
    assert.ok(result.ok,JSON.stringify(result));
    const after = await token("bob");
    assert.notEqual(after,before);
    await call({action:"adminMarkRead",owner:"bob",args});
    assert.equal(await token("bob"),after,"the same marker does not invalidate");
  }
  assert.equal(await token("alice"),outsider);
  await call({action:"activity",owner:"bob"});
  before = await token("bob");
  await tool("bob","list_channels",{});
  assert.notEqual(await token("bob"),before,"last activity changes the owner's settings");
  assert.equal(await token("alice"),outsider);
});
