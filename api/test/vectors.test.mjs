import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDocuments, processIndexBatch } from "../src/search/vectors.ts";
import { SEMANTIC } from "../src/search/config.ts";

function upsert(id,text=id) {
  return {action:"upsert",id,text,metadata:{vis:"pub",kind:"msg",author:"author",ch:1,day:1}};
}

function fixture() {
  const calls = {embeddings:[],upserts:[],deletes:[]};
  const state = new Map();
  const env = {
    AI:{async run(_model,input){calls.embeddings.push(input.documents);return {data:input.documents.map(text=>[text.length])};}},
    VECTORS:{
      async upsert(vectors){calls.upserts.push(vectors);for(const vector of vectors)state.set(vector.id,vector);},
      async deleteByIds(ids){calls.deletes.push(ids);for(const id of ids)state.delete(id);},
    },
  };
  return {env,calls,state};
}

test("repeated documents embed and upsert once with the final text and metadata", async () => {
  const {env,calls,state} = fixture();
  const latest = {...upsert("ws_test:1:1","latest"),metadata:{vis:"priv",kind:"msg",author:"new-author",ch:1,day:2}};
  const documents = [upsert("ws_test:1:1","old"),null,upsert("ws_test:1:2","other"),...Array.from({length:32},()=>latest)];
  await applyDocuments(env,"ws_test",documents);
  assert.deepEqual(calls.embeddings.flat(),["latest","other"]);
  assert.equal(calls.upserts.flat().length,2);
  assert.deepEqual(state.get(latest.id),{id:latest.id,values:[latest.text.length],namespace:"ws_test",metadata:latest.metadata});
  assert.notEqual(state.get(latest.id).metadata,latest.metadata);
  assert.equal(state.size,2);
});

test("redelivery in separate queue batches preserves the same vector state", async () => {
  const {env,state} = fixture();
  const document = upsert("ws_test:1:1","persisted queue job");
  await applyDocuments(env,"ws_test",[document]);
  const first = structuredClone([...state]);
  await applyDocuments(env,"ws_test",[document]);
  assert.deepEqual([...state],first);
  const deleted = {action:"delete",id:document.id};
  await applyDocuments(env,"ws_test",[deleted]);
  await applyDocuments(env,"ws_test",[deleted]);
  assert.equal(state.size,0);
});

test("a delete keeps priority over an upsert in either input order without embedding it", async () => {
  for(const deleteFirst of [false,true]) {
    const {env,calls,state} = fixture();
    const document = upsert("ws_test:1:1","old indexed text");
    state.set(document.id,document);
    const deleted = {action:"delete",id:document.id};
    await applyDocuments(env,"ws_test",deleteFirst?[deleted,document,deleted]:[document,deleted,deleted]);
    assert.equal(state.size,0);
    assert.deepEqual(calls.embeddings,[]);
    assert.deepEqual(calls.upserts,[]);
    assert.deepEqual(calls.deletes,[[document.id]]);
  }
});

test("unique upserts keep embedding limits, vector chunk boundaries and value alignment", async () => {
  const {env,calls,state} = fixture();
  const documents = Array.from({length:501},(_,index)=>upsert(`ws_test:1:${index+1}`,"x".repeat(index+1)));
  await applyDocuments(env,"ws_test",documents);
  assert.deepEqual(calls.upserts.map(batch=>batch.length),[500,1]);
  assert.ok(calls.embeddings.every(batch=>batch.length<=SEMANTIC.embedBatchSize));
  assert.equal(calls.embeddings.flat().length,501);
  assert.equal(state.size,501);
  for(const document of documents)assert.deepEqual(state.get(document.id).values,[document.text.length]);
});

test("repeated deletes stay within Vectorize's 100-ID chunks", async () => {
  const {env,calls} = fixture();
  const unique = Array.from({length:125},(_,index)=>({action:"delete",id:`ws_test:1:${index+1}`}));
  await applyDocuments(env,"ws_test",[...unique,...unique]);
  assert.deepEqual(calls.deletes.map(batch=>batch.length),[100,25]);
  assert.deepEqual(calls.deletes.flat(),unique.map(document=>document.id));
  assert.deepEqual(calls.embeddings,[]);
});

test("empty or stale-only document batches perform no AI or Vectorize work", async () => {
  const {env,calls} = fixture();
  await applyDocuments(env,"ws_test",[null,null]);
  assert.deepEqual(calls,{embeddings:[],upserts:[],deletes:[]});
});

function queueMessage(workspace,index) {
  const status = {acked:0,retried:0};
  return {
    body:{op:"upsert",ws:workspace,conv:1,seq:index,kind:"msg",version:1},
    ack(){status.acked++;},
    retry(){status.retried++;},
    status,
  };
}

test("queue deduplication acknowledges every original message and keeps namespaces separate", async () => {
  const {env,calls} = fixture();
  const requests = [];
  env.WORKSPACE = {
    idFromName(workspace){return workspace;},
    get(workspace){return {async indexDocuments(requestWorkspace,jobs){requests.push({workspace,requestWorkspace,jobs});return jobs.map(job=>upsert(`${workspace}:${job.conv}:${job.seq}`));}};},
  };
  const messages = [...Array.from({length:32},()=>queueMessage("ws_first",1)),queueMessage("ws_second",1)];
  await processIndexBatch({messages},env);
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>request.workspace===request.requestWorkspace&&request.jobs.every(job=>job.ws===request.workspace)));
  assert.equal(calls.embeddings.flat().length,2);
  assert.deepEqual(new Set(calls.upserts.flat().map(vector=>`${vector.namespace}:${vector.id}`)),new Set(["ws_first:ws_first:1:1","ws_second:ws_second:1:1"]));
  assert.ok(messages.every(message=>message.status.acked===1&&message.status.retried===0));
});

test("an embedding failure retries every original message in its workspace", async (context) => {
  context.mock.method(console,"error",()=>{});
  const {env,calls} = fixture();
  env.AI.run = async()=>{throw new Error("embedding failure");};
  env.WORKSPACE = {idFromName(workspace){return workspace;},get(){return {async indexDocuments(workspace,jobs){return jobs.map(job=>upsert(`${workspace}:${job.conv}:${job.seq}`));}};}};
  const messages = Array.from({length:32},()=>queueMessage("ws_test",1));
  await processIndexBatch({messages},env);
  assert.ok(messages.every(message=>message.status.acked===0&&message.status.retried===1));
  assert.deepEqual(calls.upserts,[]);
  assert.deepEqual(calls.deletes,[]);
});
