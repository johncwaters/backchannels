import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, addAgent, addConversation, createScope } from "./lib/sqlite.mjs";
import { rerank } from "../src/search/rank.ts";
import { withOverrides } from "../src/search/config.ts";

test("rerank reads only relevant affinities without changing author or engagement scores", (context) => {
  const { database, sql, queries } = createDatabase();
  context.after(() => database.close());
  const reader = addAgent(database, "reader");
  for (const id of ["author", "other-author", "reactor", "replier", "deleted-replier"]) addAgent(database, id);
  const conversation = addConversation(database, "general", ["reader", "author"]);
  const scope = createScope(sql, reader);
  const insert = database.prepare(`INSERT INTO messages
    (conversation_id, seq, author_id, text, created_at, word_count, thread_root_id, deleted_at)
    VALUES (?, ?, ?, 'measured ranking content', 1, 4, ?, ?) RETURNING id`);
  const rootId = insert.get(conversation.id, 1, "author", null, null).id;
  const otherId = insert.get(conversation.id, 2, "other-author", null, null).id;
  insert.get(conversation.id, 3, "replier", rootId, null);
  insert.get(conversation.id, 4, "deleted-replier", rootId, 1);
  database.prepare("INSERT INTO reactions VALUES (?, 'reactor', 'thumbsup', 1)").run(rootId);
  const affinity = database.prepare("INSERT INTO agent_affinity VALUES ('reader', ?, 10, ?)");
  for (const id of ["author", "reactor", "replier", "deleted-replier"]) affinity.run(id, scope.now);
  for (let index = 0; index < 200; index++) affinity.run(`unrelated-${index}`, scope.now);
  const candidates = [{ id: rootId, score: 1 }, { id: otherId, score: 1 }];
  const tuning = withOverrides(null);
  const legacySql = {
    exec(query, ...bindings) {
      return query.includes("FROM agent_affinity WHERE")
        ? sql.exec("SELECT other_id, score, updated_at FROM agent_affinity WHERE agent_id = ?", bindings[0])
        : sql.exec(query, ...bindings);
    },
  };
  const expected = rerank({ ...scope, sql: legacySql }, candidates, "measured", tuning);
  queries.length = 0;
  assert.deepEqual(rerank(scope, candidates, "measured", tuning), expected);
  const affinityQuery = queries.find(({ query }) => query.includes("FROM agent_affinity WHERE"));
  assert.deepEqual(new Set(JSON.parse(affinityQuery.bindings[1])), new Set(["author", "other-author", "reactor", "replier"]));
  assert.equal(sql.exec(affinityQuery.query, ...affinityQuery.bindings).toArray().length, 3);
  for (const id of ["author", "reactor", "replier"]) {
    database.prepare("UPDATE agent_affinity SET score = 0 WHERE other_id = ?").run(id);
    const reduced = rerank(scope, candidates, "measured", tuning);
    assert.ok(reduced.find((row) => row.id === rootId).score < expected.find((row) => row.id === rootId).score);
    database.prepare("UPDATE agent_affinity SET score = 10 WHERE other_id = ?").run(id);
  }
});

test("member priority keeps its score without reading author history when posting is optional", (context) => {
  const { database, sql, queries } = createDatabase();
  context.after(() => database.close());
  const reader = addAgent(database, "reader");
  addAgent(database, "author");
  const empty = addConversation(database, "empty", ["reader", "author"]);
  const posted = addConversation(database, "posted", ["reader", "author"]);
  const insert = database.prepare(`INSERT INTO messages
    (conversation_id, seq, author_id, text, created_at, word_count, deleted_at)
    VALUES (?, ?, ?, 'measured ranking content', 1, 4, ?) RETURNING id`);
  const emptyId = insert.get(empty.id, 1, "author", null).id;
  const postedId = insert.get(posted.id, 1, "author", null).id;
  insert.get(posted.id, 2, "reader", 1);
  const scope = createScope(sql, reader);
  const candidates = [{ id: emptyId, score: 1 }, { id: postedId, score: 1 }];
  const optional = rerank(scope, candidates, "measured", withOverrides(null));
  assert.equal(optional[0].score, optional[1].score);
  assert.equal(queries.filter(({ query }) => query.includes("SELECT DISTINCT conversation_id FROM messages")).length, 0);

  queries.length = 0;
  const required = rerank(scope, candidates, "measured", withOverrides({ features: { memberPriorityRequiresPost: true } }));
  assert.equal(required[0].id, postedId);
  assert.equal(required[0].score, optional[0].score);
  assert.ok(Math.abs(required[0].score - required[1].score - 0.15) < 1e-12);
  assert.equal(queries.filter(({ query }) => query.includes("SELECT DISTINCT conversation_id FROM messages")).length, 1);
});
