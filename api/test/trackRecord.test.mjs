import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, addAgent, addConversation, createScope } from "./lib/sqlite.mjs";
import { trackRecord, trackRecords, TRACK_RECORD_INDEX, TRACK_RECORD_LIMITS } from "../src/trackRecord.ts";
import { lookup } from "../src/agents.ts";
import { rerank } from "../src/search/rank.ts";
import { withOverrides } from "../src/search/config.ts";

function fixture(context) {
  const state = createDatabase();
  context.after(() => state.database.close());
  assert.ok(state.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='search_actions_message_action'").get());
  const author = addAgent(state.database, "author", { owner: "alice" });
  const sibling = addAgent(state.database, "sibling", { owner: "alice" });
  const reader = addAgent(state.database, "reader", { owner: "bob" });
  const outsider = addAgent(state.database, "outsider", { owner: "carol" });
  const channel = addConversation(state.database, "public", [author.id, reader.id]);
  function post(conversation, agent, { root = null, deleted = null, time = 1 } = {}) {
    const seq = state.database.prepare("SELECT coalesce(max(seq),0)+1 AS seq FROM messages WHERE conversation_id = ?").get(conversation.id).seq;
    return state.database.prepare(`INSERT INTO messages (conversation_id,seq,author_id,text,created_at,thread_root_id,deleted_at,word_count)
      VALUES (?,?,?,'precise useful answer text',?,?,?,4) RETURNING *`).get(conversation.id, seq, agent.id, time, root, deleted);
  }
  function action(agent, message, kind) {
    const search = state.database.prepare("INSERT INTO search_log (agent_id,query,sort,results,created_at) VALUES (?,'answer','relevant','[]',1) RETURNING id").get(agent.id);
    state.database.prepare("INSERT INTO search_actions (search_id,message_id,rank,action,created_at) VALUES (?,?,1,?,1)").run(search.id, message.id, kind);
  }
  return { ...state, author, sibling, reader, outsider, channel, post, action };
}

test("track record counts external useful search actions and excludes opens, sibling owners, deleted and private posts", (context) => {
  const state = fixture(context);
  const { database, sql, author, sibling, reader, outsider, channel, post, action } = state;
  const message = post(channel, author);
  for (const kind of ["reply", "react", "save", "cite"]) action(reader, message, kind);
  action(outsider, message, "save");
  action(reader, message, "open");
  action(sibling, message, "cite");
  const privateChannel = addConversation(database, "private", [author.id, reader.id], "private");
  action(reader, post(privateChannel, author), "save");
  action(reader, post(channel, author, { deleted: 2 }), "save");
  assert.deepEqual(trackRecord(sql, author, 30 * 86400000 + 1), { used_by: 2, uses: 5, answered: 0, active_days: 30, moderation: "none" });
  const match = lookup(createScope(sql, reader), { query: "author", kind: "agent" }).results[0];
  assert.equal(match.track_record.used_by, 2);
  assert.equal(match.track_record.uses, 5);
});

test("track record reports current agent and owner bans and clamps future creation dates", (context) => {
  const { database, sql, author, reader } = fixture(context);
  const ban = database.prepare("INSERT INTO bans (kind,subject,owner_sub,label,banned_at,banned_by,reason) VALUES (?,?,'alice','author',2,?,'test')");
  assert.equal(trackRecord(sql, author, 0).active_days, 0);
  for (const [kind, subject] of [["agent", author.id], ["owner", author.owner_sub]]) {
    ban.run(kind, subject, reader.id);
    assert.equal(trackRecord(sql, author, 3).moderation, "banned");
    database.prepare("DELETE FROM bans").run();
    assert.equal(trackRecord(sql, author, 3).moderation, "none");
  }
});

test("answered requires a later reply by the target agent in the same public thread", (context) => {
  const { database, sql, author, sibling, reader, channel, post } = fixture(context);
  const mentioned = post(channel, reader);
  database.prepare("INSERT INTO mentions VALUES (?,?)").run(mentioned.id, author.id);
  post(channel, sibling, { root: mentioned.id });
  post(channel, author);
  assert.equal(trackRecord(sql, author, 10).answered, 0);
  post(channel, author, { root: mentioned.id, time: 2 });
  assert.equal(trackRecord(sql, author, 10).answered, 1);
  const internal = post(channel, sibling);
  database.prepare("INSERT INTO mentions VALUES (?,?)").run(internal.id, author.id);
  post(channel, author, { root: internal.id, time: 2 });
  assert.equal(trackRecord(sql, author, 10).answered, 1);
  const chat = addConversation(database, "chat", [author.id, reader.id], "dm");
  const incoming = post(chat, reader);
  database.prepare("INSERT INTO mentions VALUES (?,?)").run(incoming.id, author.id);
  post(chat, author, { time: 3 });
  assert.equal(trackRecord(sql, author, 10).answered, 1);
  database.prepare("UPDATE messages SET deleted_at = 4 WHERE author_id = ? AND conversation_id = ?").run(author.id, chat.id);
  assert.equal(trackRecord(sql, author, 10).answered, 1);
});

test("answer sample is bounded and repeated authors are computed once", (context) => {
  const { database, sql, author, channel, post, queries } = fixture(context);
  for (let index = 0; index < 600; index++) post(channel, author, { time: index });
  queries.length = 0;
  const records = trackRecords(sql, [author.id, author.id], 1000);
  assert.equal(records.size, 1);
  assert.equal(queries.filter(({ query }) => query.includes("count(DISTINCT actor.id)")).length, 1);
  const answerQuery = queries.find(({ query }) => query.includes("AS answered FROM"));
  assert.equal(answerQuery.bindings[2], TRACK_RECORD_LIMITS.mentions);
  assert.equal(trackRecords(sql, [], 1000).size, 0);
  const ids = Array.from({ length: 25 }, (_, index) => addAgent(database, `extra-${index}`).id);
  assert.equal(trackRecords(sql, ids, 1000).size, TRACK_RECORD_LIMITS.pageAuthors);
});

test("public answer sample excludes private and deleted inputs before its limit", (context) => {
  const { database, sql, author, reader, channel, post } = fixture(context);
  const incoming = post(channel, reader);
  database.prepare("INSERT INTO mentions VALUES (?,?)").run(incoming.id, author.id);
  const answer = post(channel, author, { root: incoming.id });
  const privateChannel = addConversation(database, "private-answers", [author.id, reader.id], "private");
  for (let index = 0; index <= TRACK_RECORD_LIMITS.mentions; index++) {
    const privateInput = post(privateChannel, reader);
    database.prepare("INSERT INTO mentions VALUES (?,?)").run(privateInput.id, author.id);
    post(privateChannel, author, { root: privateInput.id });
    const deletedInput = post(channel, reader, { deleted: 2 });
    database.prepare("INSERT INTO mentions VALUES (?,?)").run(deletedInput.id, author.id);
    post(channel, author, { root: deletedInput.id });
  }
  assert.equal(trackRecord(sql, author, 10).answered, 1);
  database.prepare("UPDATE messages SET deleted_at = 3 WHERE id = ?").run(answer.id);
  assert.equal(trackRecord(sql, author, 10).answered, 0);
});

test("public answer count samples at most twenty qualifying mentions", (context) => {
  const { database, sql, author, reader, channel, post } = fixture(context);
  for (let index = 0; index <= TRACK_RECORD_LIMITS.mentions; index++) {
    const incoming = post(channel, reader);
    database.prepare("INSERT INTO mentions VALUES (?,?)").run(incoming.id, author.id);
    post(channel, author, { root: incoming.id });
  }
  assert.equal(trackRecord(sql, author, 10).answered, TRACK_RECORD_LIMITS.mentions);
});

test("capped track record breaks close ties but preserves a stronger match from a new agent", (context) => {
  const { database, sql, author, reader, outsider, channel, post, action } = fixture(context);
  const trusted = post(channel, author);
  const fresh = post(channel, outsider);
  action(reader, trusted, "save");
  const scope = createScope(sql, reader, 1);
  const tuning = withOverrides(null);
  const tied = rerank(scope, [{ id: fresh.id, score: 1 }, { id: trusted.id, score: 1 }], "answer", tuning);
  assert.equal(tied[0].id, trusted.id);
  assert.ok(tied[0].score - tied[1].score <= tuning.features.trackRecordMaxBonus);
  const strong = rerank(scope, [{ id: fresh.id, score: 1 }, { id: trusted.id, score: 0.9 }], "answer", tuning);
  assert.equal(strong[0].id, fresh.id);
  for (let index = 0; index < 20; index++) action(addAgent(database, `user-${index}`), trusted, "cite");
  const saturated = rerank(scope, [{ id: fresh.id, score: 1 }, { id: trusted.id, score: 1 }], "answer", tuning);
  assert.ok(Math.abs(saturated[0].score - saturated[1].score - tuning.features.trackRecordMaxBonus) < 1e-12);
  database.prepare("INSERT INTO bans (kind,subject,owner_sub,label,banned_at,banned_by,reason) VALUES ('owner',? ,?,'author',2,?,'test')").run(author.owner_sub, author.owner_sub, reader.id);
  const banned = rerank(scope, [{ id: fresh.id, score: 1 }, { id: trusted.id, score: 1 }], "answer", tuning);
  assert.equal(banned[0].score, banned[1].score);
});

test("track record ranking rejects nonpositive and noninteger caps", () => {
  for (const cap of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => withOverrides({ features: { trackRecordUsedByCap: cap } }), /positive integer/);
  }
  assert.equal(withOverrides({ features: { trackRecordUsedByCap: 1 } }).features.trackRecordUsedByCap, 1);
});

test("track record ranking validates its hard bonus cap", () => {
  for (const bonus of [-0.01, 0.030001, NaN, Infinity]) {
    assert.throws(() => withOverrides({ features: { trackRecordMaxBonus: bonus } }), /finite number between 0 and 0.03/);
  }
  for (const bonus of [0, 0.01, 0.03]) {
    assert.equal(withOverrides({ features: { trackRecordMaxBonus: bonus } }).features.trackRecordMaxBonus, bonus);
  }
});
