import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, addAgent, addConversation, createScope } from "./lib/sqlite.mjs";
import { rerank } from "../src/search/rank.ts";
import { withOverrides } from "../src/search/config.ts";

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
