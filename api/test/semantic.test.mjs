import assert from "node:assert/strict";
import { test } from "node:test";
import { searchVectors } from "../src/search/semantic.ts";
import { SEMANTIC } from "../src/search/config.ts";

const documents = [
  { id: "ws_test:7:1", score: 0.8, metadata: { vis: "priv", ch: 7, author: "alice", day: 20 } },
  { id: "ws_test:7:2:t", score: 0.9, metadata: { vis: "pub", ch: 7, author: "alice", day: 21 } },
  { id: "ws_test:8:1", score: 0.7, metadata: { vis: "pub", ch: 8, author: "alice", day: 20 } },
  { id: "ws_test:9:1", score: 0.99, metadata: { vis: "priv", ch: 9, author: "bob", day: 22 } },
];

function matches(metadata, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (typeof condition !== "object") return metadata[key] === condition;
    return (!condition.$in || condition.$in.includes(metadata[key]))
      && (condition.$gte === undefined || metadata[key] >= condition.$gte)
      && (condition.$lt === undefined || metadata[key] < condition.$lt);
  });
}

function fixture(indexed = documents) {
  const calls = { embeddings: [], queries: [] };
  const env = {
    AI: {
      async run(model, input) {
        calls.embeddings.push({ model, input });
        return { data: [[1, 2]] };
      },
    },
    VECTORS: {
      async query(vector, options) {
        calls.queries.push({ vector, options });
        return { matches: indexed.filter((document) => matches(document.metadata, options.filter)) };
      },
    },
  };
  return { env, calls };
}

test("an explicit visible private scope uses one query and preserves filters and hits", async () => {
  const { env, calls } = fixture();
  const hits = await searchVectors(env, "ws_test", "search text", {
    conversationIds: [7, 7], authorIds: ["alice"], dayFrom: 20, dayBefore: 22,
  }, [7, 9]);
  assert.equal(calls.embeddings.length, 1);
  assert.deepEqual(calls.embeddings[0], {
    model: SEMANTIC.embeddingModel,
    input: { queries: ["search text"], instruction: SEMANTIC.queryInstruction },
  });
  assert.deepEqual(calls.queries, [{
    vector: [1, 2],
    options: {
      topK: SEMANTIC.topK, namespace: "ws_test", returnMetadata: "none",
      filter: { author: { $in: ["alice"] }, day: { $gte: 20, $lt: 22 }, ch: { $in: [7] } },
    },
  }]);
  assert.deepEqual(hits, [
    { conversationId: 7, seq: 2, kind: "thread", score: 0.9 },
    { conversationId: 7, seq: 1, kind: "msg", score: 0.8 },
  ]);
});

test("a public-only scope retains its public filter and cannot search a hidden private ID", async () => {
  for (const conversationId of [8, 9]) {
    const { env, calls } = fixture();
    const hits = await searchVectors(env, "ws_test", "query", { conversationIds: [conversationId] }, [7]);
    assert.equal(calls.queries.length, 1);
    assert.deepEqual(calls.queries[0].options.filter, { vis: "pub", ch: { $in: [conversationId] } });
    assert.deepEqual(hits, conversationId === 8
      ? [{ conversationId: 8, seq: 1, kind: "msg", score: 0.7 }]
      : []);
  }
});

test("a mixed scope keeps the existing public and private query filters", async () => {
  const { env, calls } = fixture();
  await searchVectors(env, "ws_test", "query", { conversationIds: [7, 8, 9], authorIds: ["alice"] }, [7]);
  assert.deepEqual(calls.queries.map((call) => call.options.filter), [
    { author: { $in: ["alice"] }, vis: "pub", ch: { $in: [7, 8, 9] } },
    { author: { $in: ["alice"] }, ch: { $in: [7] } },
  ]);
});

test("an unscoped search keeps public access and only the caller's visible private IDs", async () => {
  const { env, calls } = fixture();
  await searchVectors(env, "ws_test", "query", {}, [7]);
  assert.deepEqual(calls.queries.map((call) => call.options.filter), [
    { vis: "pub" }, { ch: { $in: [7] } },
  ]);
  const publicOnly = fixture();
  await searchVectors(publicOnly.env, "ws_test", "query", {}, []);
  assert.deepEqual(publicOnly.calls.queries.map((call) => call.options.filter), [{ vis: "pub" }]);
});

test("large private-only scopes preserve the private filter chunk limit without a public query", async () => {
  const { env, calls } = fixture([]);
  const privateIds = Array.from({ length: SEMANTIC.privateIdsPerQuery * 2 + 1 }, (_, index) => index + 1);
  await searchVectors(env, "ws_test", "query", { conversationIds: privateIds }, privateIds);
  assert.deepEqual(calls.queries.map((call) => call.options.filter.ch.$in.length), [200, 200, 1]);
  assert.deepEqual(calls.queries.flatMap((call) => call.options.filter.ch.$in), privateIds);
  assert.ok(calls.queries.every((call) => !Object.hasOwn(call.options.filter, "vis")));
  assert.equal(calls.embeddings.length, 1);
});

test("an explicit empty scope performs no Vectorize query", async () => {
  const { env, calls } = fixture();
  assert.deepEqual(await searchVectors(env, "ws_test", "query", { conversationIds: [] }, [7]), []);
  assert.deepEqual(calls.queries, []);
});

test("malformed vector IDs are discarded and valid hits keep score order", async () => {
  const { env } = fixture([
    ...documents,
    { id: "invalid", score: 1, metadata: { vis: "priv", ch: 7 } },
  ]);
  assert.deepEqual(await searchVectors(env, "ws_test", "query", { conversationIds: [7] }, [7]), [
    { conversationId: 7, seq: 2, kind: "thread", score: 0.9 },
    { conversationId: 7, seq: 1, kind: "msg", score: 0.8 },
  ]);
});
