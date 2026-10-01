import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDatabase, addAgent, addConversation } from "./lib/sqlite.mjs";
import { buildDocument } from "../src/search/indexing.ts";
import { SEMANTIC } from "../src/search/config.ts";

function fixture(context, kind = "public") {
  const harness = createDatabase();
  context.after(() => harness.database.close());
  addAgent(harness.database,"root-author");
  addAgent(harness.database,"reply-author");
  const conversation = addConversation(harness.database,"general",["root-author","reply-author"],kind);
  function post(seq,text,{rootId=null,author="reply-author",deletedAt=null,replies=0}={}) {
    return harness.database.prepare(`INSERT INTO messages
      (conversation_id,seq,author_id,thread_root_id,text,created_at,word_count,deleted_at,reply_count,thread_version)
      VALUES (?,?,?,?,?,1,20,?,?,3) RETURNING *`)
      .get(conversation.id,seq,author,rootId,text,deletedAt,replies);
  }
  const job = {op:"upsert",ws:"ws_test",conv:conversation.id,seq:1,kind:"thread",version:3};
  const document = () => buildDocument(harness.sql,"ws_test",job);
  function previousText() {
    const posts = harness.database.prepare(`SELECT m.text,a.handle FROM messages m LEFT JOIN agents a ON a.id=m.author_id
      WHERE (m.id = (SELECT id FROM messages WHERE conversation_id=? AND seq=1)
        OR m.thread_root_id = (SELECT id FROM messages WHERE conversation_id=? AND seq=1))
        AND m.deleted_at IS NULL ORDER BY m.seq`).all(conversation.id,conversation.id);
    const label = kind === "public" || kind === "private" ? "#general" : "dm";
    return `${label} · thread · ${posts.map((post)=>`@${post.handle ?? "unknown"}: ${post.text}`).join("\n")}`.slice(0,SEMANTIC.threadTextMaxChars);
  }
  return {...harness,conversation,post,job,document,previousText};
}

for(const kind of ["public","private","dm","group"]) {
  test(`thread documents preserve ${kind} labels, author order, metadata and live replies`, (context) => {
    const {post,document,previousText,conversation,queries,explain} = fixture(context,kind);
    const root = post(1,"root",{author:"root-author",replies:3});
    post(4,"last",{rootId:root.id});
    post(2,"first",{rootId:root.id,author:"root-author"});
    post(3,"deleted",{rootId:root.id,deletedAt:1});
    post(5,"unrelated");
    const result = document();
    assert.equal(result.action,"upsert");
    assert.equal(result.text,previousText());
    assert.doesNotMatch(result.text,/deleted|unrelated/);
    assert.deepEqual(result.metadata,{vis:kind === "public"?"pub":"priv",kind:"thread",author:"root-author",ch:conversation.id,day:0});
    assert.equal(queries.length,4);
    const replyQuery = queries.find(({query})=>query.includes("SELECT m.text, a.handle"));
    const plan = explain(replyQuery).join("\n");
    assert.match(plan,/messages_thread/);
    assert.doesNotMatch(plan,/SCAN m\b|TEMP B-TREE/);
  });
}

test("capped threads preserve the prior text at root and reply UTF-16 boundaries", (context) => {
  const {database,post,document,previousText,queries} = fixture(context);
  const root = post(1,"root",{author:"root-author",replies:1});
  post(2,"reply 🦔".repeat(5000),{rootId:root.id});
  const prefix = "#general · thread · @team/root-author: ";
  for(const rootText of ["root", "r".repeat(SEMANTIC.threadTextMaxChars-prefix.length-1), "r".repeat(SEMANTIC.threadTextMaxChars-prefix.length), "r".repeat(SEMANTIC.threadTextMaxChars-prefix.length-1)+"🦔", "r".repeat(40000)]) {
    database.prepare("UPDATE messages SET text=? WHERE id=?").run(rootText,root.id);
    queries.length = 0;
    const result = document();
    assert.equal(result.text,previousText());
    assert.equal(result.text.length,SEMANTIC.threadTextMaxChars);
    assert.equal(queries.length,rootText.length+prefix.length>=SEMANTIC.threadTextMaxChars?3:4);
  }
});

test("short replies remain complete and missing author handles retain their fallback", (context) => {
  const {database,post,document,previousText,queries} = fixture(context);
  const root = post(1,"root",{author:"root-author",replies:1000});
  for(let seq=2;seq<=1001;seq++) post(seq,"x",{rootId:root.id});
  database.exec("PRAGMA foreign_keys=OFF");
  database.prepare("UPDATE messages SET author_id='missing' WHERE seq=1001").run();
  const result = document();
  assert.equal(result.text,previousText());
  assert.ok(result.text.endsWith("\n@unknown: x"));
  assert.ok(result.text.length<SEMANTIC.threadTextMaxChars);
  assert.equal(queries.length,4);
});

test("thread indexing retains stale, missing, deleted and empty-thread outcomes", (context) => {
  const {database,post,job,document,sql,conversation} = fixture(context);
  const root = post(1,"root",{author:"root-author",replies:1});
  post(2,"reply",{rootId:root.id});
  assert.equal(buildDocument(sql,"ws_test",{...job,version:2}),null);
  assert.equal(buildDocument(sql,"ws_test",{...job,seq:999}),null);
  assert.equal(buildDocument(sql,"ws_test",{...job,conv:999}),null);
  database.prepare("UPDATE messages SET deleted_at=1 WHERE id=?").run(root.id);
  assert.equal(document(),null);
  database.prepare("UPDATE messages SET deleted_at=NULL,reply_count=0 WHERE id=?").run(root.id);
  assert.deepEqual(document(),{action:"delete",id:`ws_test:${conversation.id}:1:t`});
  assert.deepEqual(buildDocument(sql,"ws_test",{op:"delete",ws:"ws_test",conv:conversation.id,seq:1,kind:"thread"}),{action:"delete",id:`ws_test:${conversation.id}:1:t`});
});

test("workerd stops thread reads at the text cap with constant query count", async (context) => {
  const require = createRequire(realpathSync(fileURLToPath(new URL("../node_modules/wrangler/package.json",import.meta.url))));
  const {build} = require("esbuild");
  const {Miniflare,convertV4MiniflareOptions} = require("miniflare");
  const schemaPath = fileURLToPath(new URL("../src/schema.ts",import.meta.url));
  const indexingPath = fileURLToPath(new URL("../src/search/indexing.ts",import.meta.url));
  const source = `
    import {DurableObject} from 'cloudflare:workers';
    import {MIGRATIONS} from ${JSON.stringify(schemaPath)};
    import {buildDocument} from ${JSON.stringify(indexingPath)};
    export class ThreadTest extends DurableObject {
      async fetch(request) {
        const count = Number(new URL(request.url).searchParams.get('count'));
        const sql = this.ctx.storage.sql;
        for(const migration of MIGRATIONS)sql.exec(migration);
        sql.exec("INSERT INTO agents (id,handle,name,description,owner_sub,owner_email,created_at,last_active_at) VALUES ('author','team/author','author','','author','author@example.com',1,1)");
        sql.exec("INSERT INTO conversations (id,kind,name,slug,created_by,created_at) VALUES (1,'public','general','general','author',1)");
        const body = 'measured thread content '.repeat(50);
        for(let seq=1;seq<=count+1;seq++)sql.exec("INSERT INTO messages (id,conversation_id,seq,author_id,thread_root_id,text,created_at,word_count,reply_count,thread_version) VALUES (?,1,?,'author',?,?,1,20,?,?)",seq,seq,seq>1?1:null,body,seq===1?count:0,seq===1?count:0);
        const cursors=[];
        const measured = {exec:(...args)=>{const cursor=sql.exec(...args);cursors.push(cursor);return cursor;}};
        const document = buildDocument(measured,'ws_test',{op:'upsert',ws:'ws_test',conv:1,seq:1,kind:'thread',version:count});
        return Response.json({document,queries:cursors.length,rowsRead:cursors.reduce((sum,cursor)=>sum+cursor.rowsRead,0),rowsWritten:cursors.reduce((sum,cursor)=>sum+cursor.rowsWritten,0)});
      }
    }
    export default {fetch(request,env){return env.TEST.get(env.TEST.idFromName(new URL(request.url).search)).fetch(request);}};
  `;
  const bundle = await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL("..",import.meta.url))},bundle:true,format:"esm",platform:"browser",external:["cloudflare:workers"],write:false});
  const miniflare = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-09-30",durableObjects:{TEST:{className:"ThreadTest",useSQLite:true}}}));
  context.after(()=>miniflare.dispose());
  const results = [];
  for(const count of [31,1000]) {
    const response = await miniflare.dispatchFetch(`http://localhost?count=${count}`);
    assert.equal(response.status,200,await response.clone().text());
    results.push(await response.json());
  }
  assert.deepEqual(results[1],results[0]);
  assert.equal(results[0].queries,4);
  assert.ok(results[0].rowsRead<=60,JSON.stringify(results[0]));
  assert.equal(results[0].rowsWritten,0);
  assert.equal(results[0].document.text.length,SEMANTIC.threadTextMaxChars);
  const priorText = `#general · thread · ${Array.from({length:32},()=>"@team/author: "+"measured thread content ".repeat(50)).join("\n")}`.slice(0,SEMANTIC.threadTextMaxChars);
  assert.equal(results[0].document.text,priorText);
  context.diagnostic(`Thread document: ${results[0].queries} queries, ${results[0].rowsRead} rows read, ${results[0].rowsWritten} rows written at both sizes`);
});
