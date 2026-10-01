import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, addAgent, addConversation, createScope } from "./lib/sqlite.mjs";
import { MIGRATIONS } from "../src/schema.ts";
const { sendMessage, markConversationRead, markThreadRead, pin } = await import("../src/messages.ts");
const { markRead } = await import("../src/inbox.ts");
const { recordSearchActions } = await import("../src/search/signals.ts");
const { adminMarkRead, adminList, adminRead } = await import("../src/adminData.ts");
const { pruneRateBuckets, RATE_LIMITS } = await import("../src/limits.ts");

const DEDUPLICATE_SEARCH_ACTIONS = MIGRATIONS.findIndex((migration) => migration.includes("search_actions_unique"));

function fixture(context, members = ["author", "reader"], kind = "public") {
  const harness = createDatabase();
  context.after(() => harness.database.close());
  const agents = Object.fromEntries(members.map((id) => [id, addAgent(harness.database, id)]));
  const conversation = addConversation(harness.database, "general", members, kind);
  return { ...harness, agents, conversation, scope: createScope(harness.sql, agents.author) };
}

function inboxReasons(database, messageId) {
  return Object.fromEntries(database.prepare("SELECT agent_id, reason FROM inbox WHERE message_id = ? ORDER BY agent_id").all(messageId)
    .map((row) => [row.agent_id, row.reason]));
}

function setPrefs(database, agentId, conversationId, level, muted = 0) {
  database.prepare("INSERT INTO prefs (agent_id, conversation_id, level, muted) VALUES (?, ?, ?, ?)").run(agentId, conversationId, level, muted);
}

function addMessage(database, conversationId, seq, { rootId = null, alsoInChannel = 0, authorId = "author", deletedAt = null } = {}) {
  return database.prepare(`INSERT INTO messages
    (conversation_id, seq, author_id, thread_root_id, also_in_channel, text, created_at, word_count, deleted_at)
    VALUES (?, ?, ?, ?, ?, 'hello', ?, 1, ?) RETURNING id`).get(conversationId, seq, authorId, rootId, alsoInChannel, seq, deletedAt).id;
}

function reportPlan(context, label, before, after) {
  context.diagnostic(JSON.stringify({ label, before, after }));
}

test("migration deduplicates action labels, keeps their earliest row and retains every search log", (context) => {
  const { database } = createDatabase(MIGRATIONS.slice(0, DEDUPLICATE_SEARCH_ACTIONS));
  context.after(() => database.close());
  database.exec(`INSERT INTO search_log VALUES (1, 'reader', 'old query', 'relevant', '[1]', 0), (2, 'reader', 'new query', 'recent', '[1]', 100);
    INSERT INTO search_actions VALUES (1, 1, 2, 'open', 10), (1, 1, 3, 'open', 20), (1, 1, 2, 'save', 30), (2, 1, 1, 'open', 40);`);
  database.exec(MIGRATIONS[DEDUPLICATE_SEARCH_ACTIONS]);
  assert.equal(database.prepare("SELECT count(*) AS count FROM search_log").get().count, 2);
  assert.deepEqual(database.prepare("SELECT rank, action, created_at FROM search_actions ORDER BY rowid").all().map((row) => ({ ...row })), [
    { rank: 2, action: "open", created_at: 10 }, { rank: 2, action: "save", created_at: 30 }, { rank: 1, action: "open", created_at: 40 },
  ]);
  assert.throws(() => database.exec("INSERT INTO search_actions VALUES (1, 1, 4, 'open', 50)"), /UNIQUE constraint/);
});

test("search actions reward each message once across searches and ignore duplicate actions and expired searches", (context) => {
  const { database, scope, sql, agents, conversation } = fixture(context);
  const messageId = addMessage(database, conversation.id, 1);
  for (const createdAt of [scope.now, scope.now - 100, 0]) {
    database.prepare("INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES ('reader', 'hello', 'recent', ?, ?)")
      .run(JSON.stringify([messageId]), createdAt);
  }
  const readerScope = createScope(sql, agents.reader);
  recordSearchActions(readerScope, "open", () => true);
  recordSearchActions(readerScope, "open", () => true);
  assert.equal(database.prepare("SELECT count(*) AS count FROM search_actions").get().count, 2);
  assert.equal(database.prepare("SELECT used FROM channel_usefulness").get().used, 1);
  assert.equal(database.prepare("SELECT score FROM agent_affinity").get().score, 0.5);
  recordSearchActions(readerScope, "save", () => true);
  assert.equal(database.prepare("SELECT count(*) AS count FROM search_actions").get().count, 4);
  assert.equal(database.prepare("SELECT used FROM channel_usefulness").get().used, 2);
});

test("search lookup plans bound the action window and index duplicate detection", (context) => {
  const before = createDatabase(MIGRATIONS.slice(0, DEDUPLICATE_SEARCH_ACTIONS));
  const after = createDatabase();
  context.after(() => { before.database.close(); after.database.close(); });
  const recent = { query: "SELECT id, results FROM search_log WHERE agent_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?", bindings: ["reader", 100, 20] };
  const duplicate = { query: "SELECT 1 FROM search_actions WHERE search_id = ? AND message_id = ? AND action = ?", bindings: [1, 1, "open"] };
  reportPlan(context, "search logs", before.explain(recent), after.explain(recent));
  reportPlan(context, "search action duplicates", before.explain(duplicate), after.explain(duplicate));
  assert.match(after.explain(recent).join("\n"), /search_log_agent_time \(agent_id=\? AND created_at>\?\)/);
  assert.match(after.explain(duplicate).join("\n"), /search_actions_unique/);
  before.database.exec("CREATE INDEX search_log_agent_id ON search_log(agent_id, id)");
  context.diagnostic(JSON.stringify({ label: "rejected id index", plan: before.explain(recent) }));
});

test("fan-out preserves default levels, overrides, mute, keywords, author and revocation exclusions with constant query count", (context) => {
  const members = ["author", "reader", "all", "mentions", "nothing", "override-all", "override-nothing", "muted", "keyword", "revoked"];
  const { database, conversation, scope, queries, explain } = fixture(context, members);
  for (const level of ["all", "mentions", "nothing"]) setPrefs(database, level, null, level);
  setPrefs(database, "override-all", null, "nothing");
  setPrefs(database, "override-all", conversation.id, "all");
  setPrefs(database, "override-nothing", null, "all");
  setPrefs(database, "override-nothing", conversation.id, "nothing");
  setPrefs(database, "muted", null, "all");
  setPrefs(database, "muted", conversation.id, null, 1);
  setPrefs(database, "revoked", null, "all");
  database.prepare("UPDATE agents SET revoked_at = 1 WHERE id = 'revoked'").run();
  database.exec("INSERT INTO keywords VALUES ('keyword', 'release'), ('muted', 'release'), ('nothing', 'release')");
  sendMessage(scope, { to: "#general", text: "RELEASE is ready" });
  assert.deepEqual(inboxReasons(database, 1), { all: "channel", keyword: "keyword", "override-all": "channel" });
  const candidateQuery = queries.find(({ query }) => query.includes("candidate JOIN agents"));
  reportPlan(context, "fan-out candidates", [
    ...explain({ query: "SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL", bindings: ["reader"] }),
    ...explain({ query: "SELECT level, muted FROM prefs WHERE agent_id = ? AND conversation_id = ?", bindings: ["reader", conversation.id] }),
    ...explain({ query: "SELECT level FROM prefs WHERE agent_id = ? AND conversation_id IS NULL", bindings: ["reader"] }),
    ...explain({ query: "SELECT keyword FROM keywords WHERE agent_id = ?", bindings: ["reader"] }),
  ], explain(candidateQuery));
  const originalQueryCount = queries.length;
  for (let index = 0; index < 100; index++) {
    const agentId = `extra-${index}`;
    addAgent(database, agentId);
    database.prepare("INSERT INTO members VALUES (?, ?, 1)").run(conversation.id, agentId);
    setPrefs(database, agentId, null, "all");
  }
  queries.length = 0;
  sendMessage(scope, { to: "#general", text: "RELEASE is ready" });
  assert.equal(queries.length, originalQueryCount);
  assert.equal(Object.keys(inboxReasons(database, 2)).length, 103);
  assert.equal(queries.filter(({ query }) => query.includes("INSERT INTO inbox")).length, 1);
});

for (const kind of ["public", "private", "dm", "group"]) {
  test(`direct mentions beat mute and nothing; ${kind} visibility and private chat priority hold`, (context) => {
    const { database, conversation, scope } = fixture(context, ["author", "reader", "muted", "revoked"], kind);
    addAgent(database, "outsider");
    setPrefs(database, "reader", null, "nothing");
    setPrefs(database, "reader", conversation.id, "nothing", 1);
    setPrefs(database, "muted", conversation.id, "all", 1);
    database.exec("UPDATE agents SET revoked_at = 1 WHERE id = 'revoked'");
    const sent = sendMessage(scope, { to: "general", text: "@team/reader @team/outsider @team/revoked @team/author" });
    assert.deepEqual(inboxReasons(database, 1), kind === "public" ? { outsider: "mention", reader: "mention" } : { reader: "mention" });
    assert.deepEqual(sent.not_notified ?? [], kind === "public" ? [] : ["@team/outsider"]);
    database.exec("DELETE FROM prefs WHERE agent_id = 'reader' AND conversation_id IS NOT NULL");
    sendMessage(scope, { to: "general", text: "hello" });
    assert.deepEqual(inboxReasons(database, 2), ["dm", "group"].includes(kind) ? { reader: "dm" } : {});
  });
}

test("thread, keyword, broadcast and channel priority preserve membership and activity boundaries", (context) => {
  const members = ["author", "reader", "keyword", "active", "inactive", "all", "off", "nothing", "muted"];
  const { database, conversation, scope } = fixture(context, members);
  const rootId = addMessage(database, conversation.id, 1);
  database.prepare("UPDATE conversations SET last_seq = 1 WHERE id = ?").run(conversation.id);
  addAgent(database, "departed");
  for (const [agentId, state] of [["reader", "on"], ["departed", "auto"], ["off", "off"], ["nothing", "on"], ["muted", "on"]]) {
    database.prepare("INSERT INTO thread_follows VALUES (?, ?, ?)").run(agentId, rootId, state);
  }
  setPrefs(database, "all", null, "all");
  setPrefs(database, "nothing", null, "nothing");
  setPrefs(database, "muted", conversation.id, null, 1);
  database.exec("INSERT INTO keywords VALUES ('reader', 'release'), ('keyword', 'release'), ('departed', 'release')");
  database.prepare("UPDATE agents SET last_active_at = ? WHERE id = 'inactive'").run(scope.now - 15 * 60_000);
  sendMessage(scope, { to: "#general", text: "release @here", reply_to: "general/1" });
  assert.deepEqual(inboxReasons(database, 2), {
    active: "channel_mention", all: "channel_mention", departed: "thread", keyword: "keyword", off: "channel_mention", reader: "thread",
  });
  sendMessage(scope, { to: "#general", text: "release", reply_to: "general/1" });
  assert.deepEqual(inboxReasons(database, 3), { departed: "thread", keyword: "keyword", reader: "thread" });
  sendMessage(scope, { to: "#general", text: "release", reply_to: "general/1", also_send_to_channel: true });
  assert.deepEqual(inboxReasons(database, 4), { all: "channel", departed: "thread", keyword: "keyword", reader: "thread" });
  sendMessage(scope, { to: "#general", text: "@channel" });
  assert.deepEqual(inboxReasons(database, 5), { active: "channel_mention", all: "channel_mention", inactive: "channel_mention", keyword: "channel_mention", off: "channel_mention", reader: "channel_mention" });
});

test("keyword batching preserves the existing single-word and multi-word matching behavior", (context) => {
  const { database, scope } = fixture(context, ["author", "reader", "phrase", "substring"]);
  database.exec("INSERT INTO keywords VALUES ('reader', 'error'), ('phrase', 'deploy failed'), ('substring', 'err')");
  sendMessage(scope, { to: "#general", text: "ERROR deploy deploy failed" });
  assert.deepEqual(inboxReasons(database, 1), { phrase: "keyword", reader: "keyword" });
});

function readFixture(context) {
  const harness = fixture(context);
  const { database, conversation, agents, sql } = harness;
  const rootId = addMessage(database, conversation.id, 1);
  const hiddenReply = addMessage(database, conversation.id, 2, { rootId });
  const broadcastReply = addMessage(database, conversation.id, 3, { rootId, alsoInChannel: 1 });
  const laterMessage = addMessage(database, conversation.id, 4);
  const otherConversation = addConversation(database, "other", ["author", "reader"]);
  const otherMessage = addMessage(database, otherConversation.id, 1);
  database.prepare("UPDATE conversations SET last_seq = 4 WHERE id = ?").run(conversation.id);
  for (const agentId of ["author", "reader"]) {
    for (const messageId of [rootId, hiddenReply, broadcastReply, laterMessage, otherMessage]) {
      database.prepare("INSERT INTO inbox VALUES (?, ?, 'mention', 1, NULL)").run(agentId, messageId);
    }
  }
  return { ...harness, rootId, hiddenReply, broadcastReply, laterMessage, otherMessage, readerScope: createScope(sql, agents.reader) };
}

test("channel and thread reads touch only matching unread inbox rows and never move markers backwards", (context) => {
  const { database, readerScope, conversation, rootId, queries, explain } = readFixture(context);
  markConversationRead(readerScope, conversation.id, 3);
  markConversationRead(readerScope, conversation.id, 1);
  assert.deepEqual(database.prepare("SELECT message_id FROM inbox WHERE agent_id = 'reader' AND read_at IS NOT NULL ORDER BY message_id").all().map((row) => row.message_id), [1, 3]);
  assert.equal(database.prepare("SELECT last_read_seq FROM read_markers").get().last_read_seq, 3);
  markThreadRead(readerScope, rootId, 2);
  assert.deepEqual(database.prepare("SELECT message_id FROM inbox WHERE agent_id = 'reader' AND read_at IS NOT NULL ORDER BY message_id").all().map((row) => row.message_id), [1, 2, 3]);
  assert.equal(database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'author' AND read_at IS NOT NULL").get().count, 0);
  for (const statement of queries.filter(({ query }) => query.startsWith("UPDATE inbox"))) {
    const previousQuery = statement.query.replace(" INDEXED BY inbox_unread", "").replace("AND EXISTS (", "AND message_id IN (")
      .replace("SELECT 1 FROM messages WHERE id = inbox.message_id AND", "SELECT id FROM messages WHERE");
    const plan = explain(statement);
    reportPlan(context, "mark read", explain({ ...statement, query: previousQuery }), plan);
    assert.match(plan.join("\n"), /inbox_unread \(agent_id=\? AND read_at=\?\)/);
    assert.match(plan.join("\n"), /messages USING INTEGER PRIMARY KEY/);
  }
});

test("mark unread restores only the requested channel or thread range and preserves other inbox state", (context) => {
  const { database, readerScope, queries, explain } = readFixture(context);
  database.exec("UPDATE inbox SET read_at = 10");
  markRead(readerScope, { conversation: "#general", unread: true, up_to: "general/3" });
  assert.deepEqual(database.prepare("SELECT message_id FROM inbox WHERE agent_id = 'reader' AND read_at IS NULL ORDER BY message_id").all().map((row) => row.message_id), [3, 4]);
  markRead(readerScope, { conversation: "general/1/t", unread: true, up_to: "general/2" });
  assert.deepEqual(database.prepare("SELECT message_id FROM inbox WHERE agent_id = 'reader' AND read_at IS NULL ORDER BY message_id").all().map((row) => row.message_id), [2, 3, 4]);
  assert.equal(database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'author' AND read_at IS NULL").get().count, 0);
  const statements = queries.filter(({ query }) => query.startsWith("UPDATE inbox"));
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    const plan = explain(statement).join("\n");
    reportPlan(context, "mark unread", [], explain(statement));
    assert.doesNotMatch(plan, /inbox_unread/);
    assert.match(plan, /SEARCH messages USING (COVERING )?INDEX \w+ \((conversation_id=\? AND seq>\?|thread_root_id=\? AND seq>\?)\)/);
    assert.match(plan, /SEARCH inbox USING (COVERING )?INDEX sqlite_autoindex_inbox_1 \(agent_id=\? AND message_id=\?\)|SEARCH inbox USING PRIMARY KEY/);
  }
});

test("admin counts cap at 100 and preserve exact small counts and pin visibility", (context) => {
  const { database, sql, queries, explain, scope, conversation } = fixture(context);
  const adminContext = { sql, now: 10_000_000, sub: "reader", audit() {} };
  database.exec("INSERT INTO viewers VALUES ('reader', 0)");
  database.prepare("INSERT INTO viewer_reads VALUES ('reader', ?, 0, 1)").run(conversation.id);
  for (let seq = 1; seq <= 99; seq++) addMessage(database, conversation.id, seq);
  const counts = () => adminList(adminContext, { scope: "mine" }).value.conversations[0];
  assert.equal(counts().messagesToday, 99);
  assert.equal(counts().unread, 99);
  addMessage(database, conversation.id, 100);
  addMessage(database, conversation.id, 101);
  addMessage(database, conversation.id, 102, { authorId: "reader" });
  addMessage(database, conversation.id, 103, { deletedAt: 1 });
  const rootId = database.prepare("SELECT id FROM messages WHERE conversation_id = ? AND seq = 1").get(conversation.id).id;
  for (let seq = 104; seq <= 250; seq++) addMessage(database, conversation.id, seq, { rootId });
  pin(scope, { message: "general/1" });
  assert.equal(database.prepare("SELECT conversation_id FROM pins").get().conversation_id, conversation.id);
  const large = counts();
  assert.equal(large.messagesToday, 100);
  assert.equal(large.unread, 100);
  assert.equal(large.pins, 1);
  const page = adminRead(adminContext, { conversation: "general", before: 2, limit: 20 }).value;
  assert.equal(page.messages[0].unreadReplies, 100);
  database.prepare("UPDATE conversations SET last_seq = 250 WHERE id = ?").run(conversation.id);
  assert.equal(adminMarkRead(adminContext, { conversation: "general", upToSeq: 1 }).value.unread, 100);
  assert.equal(adminMarkRead(adminContext, { conversation: "general", upToSeq: 2 }).value.unread, 99);
  database.prepare("UPDATE messages SET deleted_at = 1 WHERE id = ?").run(rootId);
  assert.equal(counts().pins, 0);
  const listed = queries.find(({ query }) => query.includes("listed AS"));
  const plan = explain(listed).join("\n");
  assert.match(plan, /pins_conversation/);
  assert.match(plan, /messages_live_stream/);
  assert.match(plan, /messages_live_conv_time/);
});

test("admin read opens at the first unread only when live stream messages exceed the page", (context) => {
  const { database, sql, queries, conversation } = fixture(context);
  const adminContext = { sql, now: 10_000_000, sub: "reader", audit() {} };
  database.exec("INSERT INTO viewers VALUES ('reader', 0)");
  database.prepare("INSERT INTO viewer_reads VALUES ('reader', ?, 1, 1)").run(conversation.id);
  for (let seq = 1; seq <= 21; seq++) addMessage(database, conversation.id, seq);
  const read = (options = {}) => adminRead(adminContext, { conversation: "general", limit: 20, ...options }).value;
  assert.deepEqual(read().messages.map((message) => message.seq), Array.from({ length: 20 }, (_, index) => index + 2));
  addMessage(database, conversation.id, 22, { deletedAt: 1 });
  const rootId = database.prepare("SELECT id FROM messages WHERE conversation_id = ? AND seq = 1").get(conversation.id).id;
  addMessage(database, conversation.id, 23, { rootId });
  assert.deepEqual(read().messages.map((message) => message.seq), Array.from({ length: 20 }, (_, index) => index + 2));
  addMessage(database, conversation.id, 24);
  assert.deepEqual(read().messages.map((message) => message.seq), Array.from({ length: 11 }, (_, index) => index + 1));
  assert.equal(read({ before: 25 }).messages.at(-1).seq, 24);
  assert.equal(read({ after: 1 }).messages[0].seq, 2);
  assert.equal(read({ thread: 1 }).messages.at(-1).seq, 23);
  const probes = queries.filter(({ query }) => query.includes("OFFSET ?3"));
  assert.ok(probes.length > 0);
  assert.ok(probes.every(({ bindings }) => bindings[2] === 20));
});

test("admin mark-read runs one slug lookup and recomputes only the target unread count", (context) => {
  const { database, sql, queries, explain } = readFixture(context);
  database.exec("INSERT INTO viewers VALUES ('reader', 0)");
  const adminContext = { sql, now: 10_000_000, sub: "reader", audit() {} };
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", upToSeq: 1 }), { ok: true, value: { unread: 2 } });
  const listed = queries.filter(({ query }) => query.includes("listed AS"));
  assert.equal(listed.length, 1);
  const previousQuery = listed[0].query.replace(" AND c.slug = ?3", "").replace("FROM marked WHERE (kind = 'public' OR is_mine = 1) AND 1", "FROM marked WHERE (kind = 'public' OR is_mine = 1) AND slug = ?3");
  reportPlan(context, "admin findReadable", explain({ ...listed[0], query: previousQuery }), explain(listed[0]));
  assert.match(explain(listed[0]).join("\n"), /SEARCH c USING INDEX .* \(slug=\?\)/);
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", thread: 1, upToSeq: 3 }), { ok: true, value: { unread: 2 } });
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", upToSeq: 3 }), { ok: true, value: { unread: 1 } });
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", upToSeq: 1 }), { ok: true, value: { unread: 1 } });
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", upToSeq: 999 }), { ok: true, value: { unread: 0 } });
  assert.equal(adminList(adminContext, { scope: "mine" }).value.conversations.length, 2);
});

test("admin mark-read respects private visibility, archived channels, own authors and deleted messages", (context) => {
  const { database, sql, conversation } = fixture(context);
  const adminContext = { sql, now: 10_000_000, sub: "reader", audit() {} };
  database.exec("INSERT INTO viewers VALUES ('reader', 0)");
  addMessage(database, conversation.id, 1);
  addMessage(database, conversation.id, 2, { authorId: "reader" });
  addMessage(database, conversation.id, 3, { deletedAt: 5 });
  addMessage(database, conversation.id, 4);
  database.prepare("UPDATE conversations SET last_seq = 4 WHERE id = ?").run(conversation.id);
  assert.equal(adminMarkRead(adminContext, { conversation: "general", upToSeq: 1 }).value.unread, 1);
  addConversation(database, "private", ["author"], "private");
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "private", upToSeq: 1 }), { ok: false, error: "not_found" });
  database.exec("UPDATE conversations SET archived_at = 1 WHERE slug = 'general'");
  assert.deepEqual(adminMarkRead(adminContext, { conversation: "general", upToSeq: 1 }), { ok: false, error: "not_found" });
});

test("rate bucket pruning is bounded, preserves refillable buckets and seeks by expiry", (context) => {
  const { database, sql, queries, explain, scope } = fixture(context);
  const maxWindowMs = Math.max(...Object.values(RATE_LIMITS).flat().map((limit) => limit.windowMs));
  const cutoff = scope.now - maxWindowMs;
  for (let index = 0; index < 150; index++) {
    database.prepare("INSERT INTO rate_buckets VALUES (?, 0, ?)").run(`expired-${index}`, cutoff - index);
  }
  database.prepare("INSERT INTO rate_buckets VALUES ('active', 0, ?)").run(cutoff + 1);
  pruneRateBuckets(sql, scope.now);
  assert.equal(database.prepare("SELECT count(*) AS count FROM rate_buckets").get().count, 51);
  assert.ok(database.prepare("SELECT key FROM rate_buckets WHERE key = 'active'").get());
  pruneRateBuckets(sql, scope.now);
  assert.deepEqual(database.prepare("SELECT key FROM rate_buckets").all().map((row) => row.key), ["active"]);
  const before = createDatabase(MIGRATIONS.slice(0, DEDUPLICATE_SEARCH_ACTIONS));
  context.after(() => before.database.close());
  const pruneQuery = queries.find(({ query }) => query.startsWith("DELETE FROM rate_buckets"));
  reportPlan(context, "rate bucket cleanup (previously absent)", before.explain(pruneQuery), explain(pruneQuery));
  assert.match(explain(pruneQuery).join("\n"), /rate_buckets_updated \(updated_at<\?\)/);
  const followers = { query: "SELECT agent_id, state FROM thread_follows WHERE root_id = ?", bindings: [1] };
  reportPlan(context, "thread followers", before.explain(followers), explain(followers));
  assert.match(explain(followers).join("\n"), /thread_follows_root \(root_id=\?\)/);
});
