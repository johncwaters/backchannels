import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { adminChangeToken } from "../src/adminRevision.ts";

const require = createRequire(realpathSync(fileURLToPath(new URL("../node_modules/wrangler/package.json", import.meta.url))));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const workspacePath = fileURLToPath(new URL("../src/workspace.ts", import.meta.url));

async function runtime(context) {
  const source = `
    import { WorkspaceDO } from ${JSON.stringify(workspacePath)};
    const now = 1800000000000;
    Date.now = () => now;
    const workspaceId = 'ws_test';
    const caller = (owner) => ({ workspaceId, agent:'worker', grantId:'grant', ownerSub:owner, ownerEmail:owner+'@example.com', ownerName:owner });
    const admin = (owner) => ({workspaceId, grantId:'grant', sub:owner});
    export class TestWorkspace extends WorkspaceDO {
      constructor(ctx, env) {
        super(ctx, {...env, INDEX_QUEUE:{async sendBatch(){}}, PUBLIC_URL:'http://localhost'});
        this.workspaceDomain = 'example.com';
      }
      async perform(input) {
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
        if(input.action === 'revoke') return this.revokeOwnerAgent(input.owner,input.owner+'/worker','grant');
        if(input.action === 'adminRead') return this.adminRead(admin(input.owner), input.args);
        if(input.action === 'adminMarkRead') return this.adminMarkRead(admin(input.owner), input.args);
        if(input.action === 'activity') return this.ctx.storage.sql.exec('UPDATE agents SET last_active_at = 0 WHERE id = ?', input.owner).rowsWritten;
        if(input.action === 'history') return this.ctx.storage.sql.exec(
          "WITH RECURSIVE seq(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM seq WHERE n < 1200) INSERT INTO messages (conversation_id,seq,author_id,text,created_at,word_count) SELECT (SELECT id FROM conversations WHERE slug='public'),n,'alice','history',?,1 FROM seq", now,
        ).rowsWritten;
        return this.tool(input.name, caller(input.owner), input.args);
      }
    }
    export default {async fetch(request, env) {
      const object = env.TEST.get(env.TEST.idFromName('test'));
      return Response.json(await object.perform(await request.json()));
    }};
  `;
  const bundle = await build({stdin:{contents:source, resolveDir:fileURLToPath(new URL("..",import.meta.url))}, bundle:true, format:"esm", platform:"browser", external:["cloudflare:workers"], write:false});
  const miniflare = new Miniflare(convertV4MiniflareOptions({modules:true, script:bundle.outputFiles[0].text, compatibilityDate:"2026-09-30", durableObjects:{TEST:{className:"TestWorkspace",useSQLite:true}}}));
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
