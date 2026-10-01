import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDatabase } from "./lib/sqlite.mjs";

const { buildBrief } = await import("../src/brief.ts");
const { inviteToChannel, joinChannel, leaveChannel, updateChannel } = await import("../src/conversations.ts");
const { requireOpen } = await import("../src/store.ts");
const { lookup } = await import("../src/agents.ts");
const { deleteMessage, editMessage, keywordMatcher, pin, react, readMessages, sendMessage } = await import("../src/messages.ts");
const { checkInbox, markRead } = await import("../src/inbox.ts");
const { searchMessages } = await import("../src/search/index.ts");
const { recordSearchActions } = await import("../src/search/signals.ts");
const { SEARCH } = await import("../src/search/config.ts");
const { buildDocument } = await import("../src/search/indexing.ts");
const { retryWorkspaceRead, WorkspaceResetError } = await import("../src/workspaceRetry.ts");
const { replaceEmojiShortcodes } = await import("../../shared/emoji.ts");

describe("workspace deploy reset recovery", () => {
  const reset = () => new Error("Durable Object reset because its code was updated.");

  test("a safe stub read that resets once retries once", async () => {
    let calls = 0;
    const stub = { async tool() { if (++calls === 1) throw reset(); return { output: { items: [] } }; } };
    assert.deepEqual(await retryWorkspaceRead(() => stub.tool(), true), { output: { items: [] } });
    assert.equal(calls, 2);
  });

  test("a write is never repeated and gets an explicit retry instruction", async () => {
    let calls = 0;
    const stub = { async tool() { calls++; throw reset(); } };
    await assert.rejects(retryWorkspaceRead(() => stub.tool(), false), error => error instanceof WorkspaceResetError && /retry this call once/.test(error.message));
    assert.equal(calls, 1);
  });

  test("a read that resets twice stops with the retry instruction", async () => {
    let calls = 0;
    await assert.rejects(retryWorkspaceRead(async () => { calls++; throw reset(); }, true), WorkspaceResetError);
    assert.equal(calls, 2);
  });

  test("other failures are not retried or changed", async () => {
    let calls = 0;
    const failure = new Error("Durable Object overloaded");
    await assert.rejects(retryWorkspaceRead(async () => { calls++; throw failure; }, true), error => error === failure);
    assert.equal(calls, 1);
  });

  test("a different failure on the second attempt remains unchanged", async () => {
    let calls = 0;
    const failure = new Error("permission denied");
    await assert.rejects(retryWorkspaceRead(async () => { if (++calls === 1) throw reset(); throw failure; }, true), error => error === failure);
    assert.equal(calls, 2);
  });
});

function createWorkspace(testContext) {
  const { database, sql } = createDatabase();
  testContext.after(() => database.close());
  for (const agentId of ["reader", "writer"]) {
    database.prepare(
      `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
       VALUES (?, ?, ?, '', ?, ?, 1, 1)`,
    ).run(agentId, `owner/${agentId}`, agentId, agentId, `${agentId}@example.com`);
  }
  function scopeFor(agentId) {
    return {
      sql,
      now: 10_000,
      agent: database.prepare("SELECT * FROM agents WHERE id = ?").get(agentId),
      workspaceId: "ws_test",
      env: {},
      indexJobs: [],
    };
  }
  function createConversation(slug, kind = "public", members = ["reader", "writer"]) {
    const conversationId = Number(database.prepare(
      "INSERT INTO conversations (kind, name, slug, created_by, created_at) VALUES (?, ?, ?, 'writer', 1)",
    ).run(kind, kind === "public" || kind === "private" ? slug : null, slug).lastInsertRowid);
    for (const agentId of members) {
      database.prepare("INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, ?, 1)").run(conversationId, agentId);
    }
    return conversationId;
  }
  function addMessage(conversationId, seq, { author = "writer", rootId = null, text = "matching content", createdAt = seq } = {}) {
    const messageId = Number(database.prepare(
      "INSERT INTO messages (conversation_id, seq, author_id, thread_root_id, text, created_at, word_count) VALUES (?, ?, ?, ?, ?, ?, 2)",
    ).run(conversationId, seq, author, rootId, text, createdAt).lastInsertRowid);
    database.prepare("UPDATE conversations SET last_seq = max(last_seq, ?) WHERE id = ?").run(seq, conversationId);
    if (rootId) {
      database.prepare("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ?, thread_version = thread_version + 1 WHERE id = ?").run(createdAt, rootId);
    }
    return messageId;
  }
  return { database, scopeFor, createConversation, addMessage };
}

describe("message emoji shortcodes", () => {
  for (const [name, input, expected] of [
    ["known and repeated shortcodes", ":wave: :rocket::rocket: :+1:", "👋 🚀🚀 👍"],
    ["unknown shortcodes", ":not-an-emoji: :constructor: :wave:", ":not-an-emoji: :constructor: 👋"],
    ["URLs and times", "http://x:8080/ at 10:30:00 :wave:", "http://x:8080/ at 10:30:00 👋"],
    ["shortcodes in URLs", "[site :wave:](https://example.com/:wave:) :wave:", "[site 👋](https://example.com/:wave:) 👋"],
    ["inline code", "`:wave:` and :wave:", "`:wave:` and 👋"],
    ["multiple backtick code spans", "`` `:wave:` `` and :wave:", "`` `:wave:` `` and 👋"],
    ["multiline code spans", "`:wave:\n:rocket:` and :wave:", "`:wave:\n:rocket:` and 👋"],
    ["unmatched inline backticks", "`:wave: and :rocket:", "`👋 and 🚀"],
    ["escaped shortcodes and backticks", "\\:wave: \\`:rocket: :wave:", "\\:wave: \\`🚀 👋"],
    ["backtick fences", ":wave:\n```js\n:wave:\n```\n:wave:", "👋\n```js\n:wave:\n```\n👋"],
    ["tilde fences", ":wave:\n~~~\n:wave:\n~~~\n:wave:", "👋\n~~~\n:wave:\n~~~\n👋"],
    ["longer fences", "````\n``` :wave:\n````\n:wave:", "````\n``` :wave:\n````\n👋"],
    ["unclosed fences", ":wave:\n```\n:wave:", "👋\n```\n:wave:"],
    ["quoted fences", "> ```\n> :wave:\n> ```\n:wave:", "> ```\n> :wave:\n> ```\n👋"],
    ["list fences", "- ```\n  :wave:\n  ```\n:wave:", "- ```\n  :wave:\n  ```\n👋"],
    ["quoted or list markers inside a fence", "```\n> ```\n:wave:\n- ```\n:rocket:\n```\n:wave:", "```\n> ```\n:wave:\n- ```\n:rocket:\n```\n👋"],
    ["CRLF fences", ":wave:\r\n```\r\n:wave:\r\n```\r\n:wave:", "👋\r\n```\r\n:wave:\r\n```\r\n👋"],
  ]) {
    test(`converts prose and preserves ${name}`, () => {
      assert.equal(replaceEmojiShortcodes(input), expected);
      assert.equal(replaceEmojiShortcodes(expected), expected);
    });
  }

  test("send and edit store converted text and preserve code", (testContext) => {
    const { database, scopeFor, createConversation } = createWorkspace(testContext);
    const conversationId = createConversation("emoji");
    const sent = sendMessage(scopeFor("writer"), { to: "#emoji", text: "Hello :wave: `:wave:` @owner/reader" });
    assert.equal(database.prepare("SELECT text FROM messages WHERE conversation_id = ?").get(conversationId).text, "Hello 👋 `:wave:` @owner/reader");
    assert.equal(checkInbox(scopeFor("reader"), {}).items[0].message.text, "Hello 👋 `:wave:` @owner/reader");
    editMessage(scopeFor("writer"), { message: sent.message, text: ":rocket:\n```\n:wave:\n```" });
    const stored = database.prepare("SELECT text, has_code FROM messages WHERE conversation_id = ?").get(conversationId);
    assert.equal(stored.text, "🚀\n```\n:wave:\n```");
    assert.equal(stored.has_code, 1);
  });

  test("expanded emoji text still respects the stored message limit", (testContext) => {
    const { database, scopeFor, createConversation } = createWorkspace(testContext);
    createConversation("emoji-limit");
    const oversized = ":wales:".repeat(5000);
    assert.throws(() => sendMessage(scopeFor("writer"), { to: "#emoji-limit", text: oversized }), /the limit is 40000/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
    const sent = sendMessage(scopeFor("writer"), { to: "#emoji-limit", text: "Original :wave:" });
    assert.throws(() => editMessage(scopeFor("writer"), { message: sent.message, text: oversized }), /the limit is 40000/);
    assert.equal(database.prepare("SELECT text FROM messages").get().text, "Original 👋");
  });
});

describe("brief visibility and follows", () => {
  test("private channels and chats require membership, while public follows remain visible", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    for (const [slug, kind] of [["public", "public"], ["private", "private"], ["dm:chat", "dm"], ["dm:group", "group"]]) {
      const conversationId = createConversation(slug, kind, ["writer"]);
      const rootId = addMessage(conversationId, 1);
      addMessage(conversationId, 2, { rootId });
      database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'on')").run(rootId);
      database.prepare("INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, 'reader', 1)").run(rootId);
    }
    const brief = buildBrief(scopeFor("reader"));
    assert.deepEqual(brief.threads.map((thread) => thread.thread), ["public/1/t"]);
    assert.deepEqual(brief.pins.map((message) => message.id), ["public/1"]);
    database.exec("INSERT INTO members (conversation_id, agent_id, joined_at) SELECT id, 'reader', 1 FROM conversations WHERE kind != 'public'");
    assert.equal(buildBrief(scopeFor("reader")).threads.length, 4);
    assert.equal(buildBrief(scopeFor("reader")).pins.length, 4);
  });

  test("limits threads while keeping unread-first ordering and exact reply counts", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("threads");
    const rootIds = [];
    for (let index = 0; index < 7; index++) {
      const rootId = addMessage(conversationId, index * 3 + 1);
      rootIds.push(rootId);
      addMessage(conversationId, index * 3 + 2, { rootId });
      addMessage(conversationId, index * 3 + 3, { rootId, author: "reader" });
      database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'auto')").run(rootId);
    }
    database.prepare("INSERT INTO thread_reads (agent_id, root_id, last_read_seq) VALUES ('reader', ?, 99)").run(rootIds[6]);
    const threads = buildBrief(scopeFor("reader")).threads;
    assert.deepEqual(threads.map((thread) => thread.thread), ["threads/16/t", "threads/13/t", "threads/10/t", "threads/7/t", "threads/4/t"]);
    assert.deepEqual(threads.map((thread) => thread.unread_replies), [1, 1, 1, 1, 1]);
  });

  test("leaving removes only that agent's follows in that conversation", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const leftId = createConversation("left", "private");
    const keptId = createConversation("kept");
    const leftRoot = addMessage(leftId, 1);
    const keptRoot = addMessage(keptId, 1);
    database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'on'), ('reader', ?, 'off'), ('writer', ?, 'auto')").run(leftRoot, keptRoot, leftRoot);
    assert.equal(leaveChannel(scopeFor("reader"), { channel: "#left" }).left, true);
    assert.deepEqual(database.prepare("SELECT agent_id, root_id FROM thread_follows ORDER BY agent_id").all().map((row) => [row.agent_id, row.root_id]), [["reader", keptRoot], ["writer", leftRoot]]);
  });
});

describe("inbox visibility after membership changes", () => {
  test("leaving a private channel hides its old inbox posts and counts", testContext => {
    const { database, scopeFor, createConversation } = createWorkspace(testContext);
    createConversation("private-inbox", "private");
    createConversation("public-inbox");
    const secret = sendMessage(scopeFor("writer"), { to: "#private-inbox", text: "Private @owner/reader" });
    const first = sendMessage(scopeFor("writer"), { to: "#public-inbox", text: "Public first @owner/reader" });
    const second = sendMessage(scopeFor("writer"), { to: "#public-inbox", text: "Public second @owner/reader" });
    const reader = scopeFor("reader");
    assert.equal(checkInbox(reader, {}).items.length, 3);
    leaveChannel(reader, { channel: "#private-inbox" });
    leaveChannel(reader, { channel: "#public-inbox" });
    assert.throws(() => readMessages(reader, { conversation: secret.message }), /not found/);
    const page = checkInbox(reader, { limit: 1 });
    assert.deepEqual(page.items.map(item => item.message.id), [first.message]);
    assert.deepEqual(page.counts, { mention: 2 });
    assert.ok(page.next_cursor);
    const next = checkInbox(reader, { limit: 1, cursor: page.next_cursor });
    assert.deepEqual(next.items.map(item => item.message.id), [second.message]);
    assert.equal(next.next_cursor, null);
    assert.deepEqual(next.counts, { mention: 2 });
    assert.equal(database.prepare("SELECT count(*) AS n FROM inbox WHERE agent_id = 'reader'").get().n, 3);
  });
});

describe("archived channel recovery", () => {
  test("posts, invites and updates name the last message and the visible move target", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const archivedId = createConversation("old-room");
    createConversation("new-room");
    createConversation("purpose-room");
    addMessage(archivedId, 1, { text: "Early message" });
    addMessage(archivedId, 2, { text: "This work moved to #new-room." });
    database.prepare("UPDATE conversations SET archived_at = 1, purpose = 'Earlier destination #purpose-room' WHERE id = ?").run(archivedId);
    const beforeMembers = database.prepare("SELECT count(*) AS n FROM members").get().n;
    const scope = scopeFor("reader");
    for (const operation of [
      () => sendMessage(scope, { to: "#old-room", text: "New post" }),
      () => inviteToChannel(scope, { channel: "#old-room", agents: ["@owner/writer"] }),
      () => updateChannel(scope, { channel: "#old-room", topic: "New topic" }),
    ]) {
      assert.throws(operation, error => /#old-room is archived/.test(error.message)
        && /conversation: 'old-room\/2'/.test(error.message)
        && /this work moved to #new-room; join it/.test(error.message)
        && !error.message.includes("#purpose-room"));
    }
    assert.equal(database.prepare("SELECT count(*) AS n FROM members").get().n, beforeMembers);
    assert.equal(database.prepare("SELECT count(*) AS n FROM messages").get().n, 2);
    assert.equal(database.prepare("SELECT topic FROM conversations WHERE id = ?").get(archivedId).topic, "");
    assert.equal(updateChannel(scope, { channel: "#old-room", archived: false }).archived, false);
    assert.ok(sendMessage(scope, { to: "#old-room", text: "Restored post" }).message);
  });

  test("purpose fallback skips missing, archived and hidden private destinations", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const archivedId = createConversation("old-room");
    const alsoArchivedId = createConversation("also-old");
    createConversation("hidden-room", "private", ["writer"]);
    createConversation("live-room");
    addMessage(archivedId, 1, { text: "Use #missing-room, #also-old or #hidden-room." });
    database.prepare("UPDATE conversations SET archived_at = 1 WHERE id IN (?, ?)").run(archivedId, alsoArchivedId);
    database.prepare("UPDATE conversations SET purpose = 'Work continues in #LIVE-ROOM' WHERE id = ?").run(archivedId);
    const conversation = database.prepare("SELECT * FROM conversations WHERE id = ?").get(archivedId);
    assert.throws(() => requireOpen(scopeFor("reader"), conversation), error => error.message.includes("this work moved to #live-room")
      && !error.message.includes("hidden-room") && !error.message.includes("also-old") && !error.message.includes("missing-room"));
  });

  test("empty and deleted-only channels keep a restoration hint without an invalid message ID", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const archivedId = createConversation("old-room");
    database.prepare("UPDATE conversations SET archived_at = 1 WHERE id = ?").run(archivedId);
    const conversation = database.prepare("SELECT * FROM conversations WHERE id = ?").get(archivedId);
    assert.throws(() => requireOpen(scopeFor("reader"), conversation), /^Error: #old-room is archived; update_channel with archived: false restores it$/);
    const messageId = addMessage(archivedId, 1, { text: "Deleted #hidden-room directive" });
    database.prepare("UPDATE messages SET deleted_at = 1 WHERE id = ?").run(messageId);
    assert.throws(() => requireOpen(scopeFor("reader"), conversation), error => !error.message.includes("conversation:") && /archived: false/.test(error.message));
  });

  test("public nonmembers receive archive recovery and readable private destinations qualify", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const archivedId = createConversation("old-room", "public", ["writer"]);
    createConversation("member-room", "private");
    addMessage(archivedId, 1, { text: "Use #member-room now." });
    database.prepare("UPDATE conversations SET archived_at = 1 WHERE id = ?").run(archivedId);
    for (const operation of [
      () => sendMessage(scopeFor("reader"), { to: "#old-room", text: "Post" }),
      () => inviteToChannel(scopeFor("reader"), { channel: "#old-room", agents: ["@owner/writer"] }),
      () => updateChannel(scopeFor("reader"), { channel: "#old-room", purpose: "Change" }),
      () => joinChannel(scopeFor("reader"), { channel: "#old-room" }),
    ]) assert.throws(operation, /this work moved to #member-room; join it/);
  });
});

describe("mark_read validates modes before state changes", () => {
  for (const args of [
    { all: true, up_to: "modes/1" },
    { all: true, unread: true },
    { all: true, unread: false },
    { messages: ["modes/1"], up_to: "modes/1" },
    { messages: ["modes/1"], unread: false },
    { all: false },
    { all: false, conversation: "#modes" },
    { all: true, messages: [] },
    { messages: [] },
    { all: true, conversation: "#modes" },
    { messages: ["modes/1"], conversation: "#modes" },
  ]) {
    test(`rejects ${JSON.stringify(args)} without clearing anything`, testContext => {
      const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
      const conversationId = createConversation("modes");
      const messageId = addMessage(conversationId, 1);
      database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES ('reader', ?, 'mention', 1)").run(messageId);
      database.prepare("INSERT INTO read_markers (agent_id, conversation_id, last_read_seq) VALUES ('reader', ?, 0)").run(conversationId);
      assert.throws(() => markRead(scopeFor("reader"), args), /omit|exactly one|messages is empty/);
      assert.equal(database.prepare("SELECT read_at FROM inbox").get().read_at, null);
      assert.equal(database.prepare("SELECT last_read_seq FROM read_markers").get().last_read_seq, 0);
      assert.equal(database.prepare("SELECT count(*) AS n FROM thread_reads").get().n, 0);
    });
  }

  test("valid conversation, messages and all modes still work", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("modes");
    const messageId = addMessage(conversationId, 1);
    database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES ('reader', ?, 'mention', 1)").run(messageId);
    assert.deepEqual(markRead(scopeFor("reader"), { messages: ["modes/1"] }).marked_read.messages, ["modes/1"]);
    assert.equal(markRead(scopeFor("reader"), { conversation: "#modes", unread: false, up_to: "modes/1" }).read_up_to, "modes/1");
    assert.equal(markRead(scopeFor("reader"), { all: true }).marked_read.inbox_items, 0);
  });
});

describe("mark_read all clears followed thread state", () => {
  test("clears public and archived thread counts and later replies become unread", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const roots = [];
    for (const slug of ["open-follow", "archived-follow"]) {
      const conversationId = createConversation(slug, "public", ["writer"]);
      const rootId = addMessage(conversationId, 1);
      const replyId = addMessage(conversationId, 2, { rootId });
      roots.push([conversationId, rootId]);
      database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'on')").run(rootId);
      database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES ('reader', ?, 'thread', 2)").run(replyId);
    }
    database.prepare("UPDATE conversations SET archived_at = 1 WHERE slug = 'archived-follow'").run();
    assert.deepEqual(buildBrief(scopeFor("reader")).threads.map(thread => thread.unread_replies), [1, 1]);
    assert.deepEqual(markRead(scopeFor("reader"), { all: true }).marked_read, { inbox_items: 2, conversations: 0, threads: 2 });
    assert.equal(checkInbox(scopeFor("reader"), {}).items.length, 0);
    assert.ok(buildBrief(scopeFor("reader")).threads.every(thread => thread.unread_replies === 0));
    assert.equal(markRead(scopeFor("reader"), { all: true }).marked_read.threads, 0);
    addMessage(roots[0][0], 3, { rootId: roots[0][1] });
    assert.equal(buildBrief(scopeFor("reader")).threads.find(thread => thread.thread === "open-follow/1/t").unread_replies, 1);
  });

  test("excludes hidden private threads, off follows and other agents", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const roots = [];
    for (const [slug, kind, members, state] of [
      ["visible-private", "private", ["reader", "writer"], "auto"],
      ["hidden-private", "private", ["writer"], "on"],
      ["hidden-chat", "dm", ["writer"], "on"],
      ["off-follow", "public", ["reader", "writer"], "off"],
    ]) {
      const conversationId = createConversation(slug, kind, members);
      const rootId = addMessage(conversationId, 1);
      addMessage(conversationId, 2, { rootId });
      roots.push(rootId);
      database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, ?), ('writer', ?, 'on')").run(rootId, state, rootId);
    }
    assert.equal(markRead(scopeFor("reader"), { all: true }).marked_read.threads, 1);
    assert.deepEqual(database.prepare("SELECT agent_id, root_id, last_read_seq FROM thread_reads").all().map(row => [row.agent_id, row.root_id, row.last_read_seq]), [["reader", roots[0], 2]]);
  });

  test("preserves newer markers and clears threads without replies", testContext => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("newer-markers");
    const rootId = addMessage(conversationId, 1);
    addMessage(conversationId, 2, { rootId });
    const emptyRootId = addMessage(conversationId, 3);
    database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'auto'), ('reader', ?, 'on')").run(rootId, emptyRootId);
    database.prepare("INSERT INTO thread_reads (agent_id, root_id, last_read_seq) VALUES ('reader', ?, 99)").run(rootId);
    assert.equal(markRead(scopeFor("reader"), { all: true }).marked_read.threads, 1);
    assert.deepEqual(database.prepare("SELECT last_read_seq FROM thread_reads ORDER BY root_id").all().map(row => row.last_read_seq), [99, 3]);
  });
});

describe("message text previews", () => {
  test("list attachments stay metadata and single-message full detail recovers inline text", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("attachments");
    const messageId = addMessage(conversationId, 1, { text: "Small attached post" });
    const fileText = "Attached report text. ".repeat(4500);
    database.prepare("INSERT INTO files (id, uploader_id, message_id, name, mime, size, r2_key, created_at, inline_text) VALUES ('f_report', 'writer', ?, 'report.txt', 'text/plain', ?, 'report', 1, ?)").run(messageId, fileText.length, fileText);
    database.prepare("UPDATE messages SET has_file = 1 WHERE id = ?").run(messageId);
    const scope = scopeFor("reader");
    const page = readMessages(scope, { conversation: "#attachments", detail: "full" });
    assert.equal(page.messages[0].files[0].text, undefined);
    assert.equal(page.messages[0].files[0].size, fileText.length);
    assert.match(page.hint, /detail: 'full'/);
    const search = await searchMessages(scope, { query: "in:#attachments", detail: "full" });
    assert.equal(search.results[0].files[0].text, undefined);
    assert.match(search.hint, /detail: 'full'/);
    const full = readMessages(scope, { conversation: page.messages[0].id, detail: "full" });
    assert.equal(full.messages[0].files[0].text, fileText);
    assert.equal(full.hint, undefined);
  });

  test("full search previews neighbours and preserves direct-message recovery", async (testContext) => {
    const { scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("search-previews");
    const text = "Long message text. ".repeat(1000);
    for (let seq = 1; seq <= 3; seq++) addMessage(conversationId, seq, { text });
    const scope = scopeFor("reader");
    const search = await searchMessages(scope, { query: "in:#search-previews", detail: "full", limit: 1 });
    const result = search.results[0];
    assert.equal(result.text, text.slice(0, 4000));
    assert.equal(result.text_truncated, true);
    assert.equal(result.text_length, text.length);
    assert.equal(result.previous.text, text.slice(0, 4000));
    assert.equal(result.previous.text_truncated, true);
    assert.equal(result.previous.text_length, text.length);
    assert.match(search.hint, /message ID as conversation to read_messages/);
    assert.equal(readMessages(scope, { conversation: result.id }).messages[0].text, text);
    const nextPage = await searchMessages(scope, { cursor: search.next_cursor, detail: "full", limit: 1 });
    assert.equal(nextPage.results[0].next.text.length, 4000);
    assert.equal(nextPage.results[0].next.text_truncated, true);
  });

  test("inbox previews preserve full text, pagination and unread state", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("previews");
    database.prepare("INSERT INTO read_markers VALUES ('reader', ?, 0)").run(conversationId);
    const texts = ["small post", "message body ".repeat(4000).slice(0, 40_000)];
    for (const [index, text] of texts.entries()) {
      const messageId = addMessage(conversationId, index + 1, { text });
      database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES ('reader', ?, 'mention', ?)").run(messageId, index + 1);
    }
    const first = checkInbox(scopeFor("reader"), { limit: 1 });
    assert.equal(first.items[0].message.text, texts[0]);
    assert.equal(first.hint, undefined);
    assert.equal(first.items[0].message.text_truncated, undefined);
    assert.equal(first.items[0].message.text_length, undefined);
    const second = checkInbox(scopeFor("reader"), { limit: 1, cursor: first.next_cursor });
    assert.equal(second.items[0].message.text, texts[1].slice(0, 1000));
    assert.equal(second.items[0].message.text_truncated, true);
    assert.equal(second.items[0].message.text_length, texts[1].length);
    assert.match(second.hint, /message ID as conversation to read_messages/);
    assert.equal(second.next_cursor, null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM inbox WHERE read_at IS NULL").get().count, 2);
    const full = readMessages(scopeFor("reader"), { conversation: second.items[0].message.id });
    assert.equal(full.messages[0].text, texts[1]);
    assert.equal(full.messages[0].text_truncated, undefined);
    assert.equal(database.prepare("SELECT last_read_seq FROM read_markers").get().last_read_seq, 0);
  });

  test("channel and thread reads preview long bodies with full recovery by message ID", (testContext) => {
    const { scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("previews");
    const text = "message body ".repeat(1000);
    const rootId = addMessage(conversationId, 1, { text });
    addMessage(conversationId, 2, { rootId, text });
    for (const conversation of ["#previews", "previews/1/t"]) {
      for (const detail of ["concise", "full"]) {
        const page = readMessages(scopeFor("reader"), { conversation, detail });
        assert.match(page.hint, /message ID as conversation to read_messages/);
        for (const message of page.messages) {
          assert.equal(message.text, text.slice(0, 4000));
          assert.equal(message.text_length, text.length);
          assert.equal(message.text_truncated, true);
          const full = readMessages(scopeFor("reader"), { conversation: message.id, detail });
          assert.equal(full.messages[0].text, text);
          assert.equal(full.messages[0].text_truncated, undefined);
        }
      }
    }
  });

  test("bodies at the cap remain unchanged and carry no truncation fields", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("exact-cap");
    const messageId = addMessage(conversationId, 1, { text: "a".repeat(1000) });
    database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) VALUES ('reader', ?, 'mention', 1)").run(messageId);
    const inbox = checkInbox(scopeFor("reader"), {});
    assert.equal(inbox.items[0].message.text.length, 1000);
    assert.equal(inbox.hint, undefined);
    const readId = addMessage(conversationId, 2, { text: "a".repeat(4000) });
    const page = readMessages(scopeFor("reader"), { conversation: "#exact-cap" });
    assert.equal(page.messages[1].text.length, 4000);
    assert.equal(page.hint, undefined);
    assert.equal(page.messages[1].text_truncated, undefined);
    assert.equal(database.prepare("SELECT length(text) AS length FROM messages WHERE id = ?").get(readId).length, 4000);
  });
});

describe("message ID boundaries", () => {
  function fixture(testContext) {
    const workspace = createWorkspace(testContext);
    const targetId = workspace.createConversation("target");
    const sourceId = workspace.createConversation("source");
    workspace.addMessage(targetId, 1);
    workspace.addMessage(targetId, 2);
    workspace.addMessage(sourceId, 1);
    workspace.database.prepare("INSERT INTO read_markers VALUES ('reader', ?, 0)").run(targetId);
    workspace.database.prepare("INSERT INTO inbox (agent_id, message_id, reason, created_at) SELECT 'reader', id, 'mention', created_at FROM messages WHERE conversation_id = ?").run(targetId);
    const readState = () => ({
      marker: workspace.database.prepare("SELECT last_read_seq FROM read_markers WHERE agent_id = 'reader' AND conversation_id = ?").get(targetId).last_read_seq,
      inbox: workspace.database.prepare("SELECT message_id, read_at FROM inbox WHERE agent_id = 'reader' ORDER BY message_id").all(),
    });
    return { ...workspace, targetId, readState };
  }

  for (const unread of [false, true]) {
    test(`mark_read refuses another conversation with unread ${unread} without changing read state`, (testContext) => {
      const { scopeFor, readState } = fixture(testContext);
      const before = readState();
      assert.throws(() => markRead(scopeFor("reader"), { conversation: "#target", up_to: "source/1", unread }), /up_to 'source\/1' names #source, not #target; pass a message ID from #target/);
      assert.deepEqual(readState(), before);
    });
  }

  for (const field of ["before", "after", "around"]) {
    test(`read_messages refuses another conversation in ${field} without changing read state`, (testContext) => {
      const { scopeFor, readState } = fixture(testContext);
      const before = readState();
      assert.throws(() => readMessages(scopeFor("reader"), { conversation: "#target", [field]: "source/1" }), new RegExp(`${field} 'source/1' names #source, not #target; pass a message ID from #target`));
      assert.deepEqual(readState(), before);
    });
  }

  test("same-conversation IDs and numeric sequence boundaries still work", (testContext) => {
    const { scopeFor, readState } = fixture(testContext);
    const scope = scopeFor("reader");
    assert.deepEqual(readMessages(scope, { conversation: "#target", after: "#TARGET/1" }).messages.map(message => message.id), ["target/2"]);
    assert.equal(markRead(scope, { conversation: "#target", up_to: "1", unread: true }).unread_from, "target/1");
    assert.equal(readState().marker, 0);
    assert.deepEqual(readMessages(scope, { conversation: "#target", before: "2" }).messages.map(message => message.id), ["target/1"]);
    assert.equal(markRead(scope, { conversation: "#target", up_to: "target/2" }).read_up_to, "target/2");
    assert.equal(readState().marker, 2);
  });

  test("thread read markers refuse an ID from another conversation", (testContext) => {
    const { database, scopeFor, targetId, addMessage } = fixture(testContext);
    const rootId = Number(database.prepare("SELECT id FROM messages WHERE conversation_id = ? AND seq = 1").get(targetId).id);
    addMessage(targetId, 3, { rootId });
    assert.throws(() => markRead(scopeFor("reader"), { conversation: "target/1/t", up_to: "source/1" }), /not #target/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_reads").get().count, 0);
    assert.throws(() => readMessages(scopeFor("reader"), { conversation: "target/1/t", after: "source/1" }), /not #target/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_reads").get().count, 0);
  });
});

describe("keyword notifications", () => {
  for (const [keyword, text, shouldNotify] of [
    ["api key", "rapi keyboard", false],
    ["api key", "API\n  KEY is missing", true],
    ["api key", "api token key", false],
    ["api key", "api keychain", false],
    ["api key", "api api key", true],
    ["api api", "api key api", false],
    ["v1.2", "Upgrade (V1.2) today", true],
    ["v1.2", "v1x2", false],
    ["v1.2", "v1.20", false],
    ["api", "api_key api-key", false],
    ["api key", "éapi key", false],
    ["c++", "Use C++ today", true],
  ]) {
    test(`${JSON.stringify(keyword)} in ${JSON.stringify(text)} notifies: ${shouldNotify}`, (testContext) => {
      const { database, scopeFor, createConversation } = createWorkspace(testContext);
      createConversation("keywords");
      database.prepare("INSERT INTO keywords (agent_id, keyword) VALUES ('reader', ?)").run(keyword);
      sendMessage(scopeFor("writer"), { to: "#keywords", text });
      assert.equal(database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'reader' AND reason = 'keyword'").get().count, Number(shouldNotify));
    });
  }
});

describe("keyword scan cost", () => {
  test("agents sharing a phrase keyword scan the message once", () => {
    const matcher = keywordMatcher("rotate the API key today");
    for (let agent = 0; agent < 200; agent++) assert.equal(matcher.matches("api key"), true);
    assert.equal(matcher.matches("rotate"), true);
    assert.equal(matcher.scannedPhraseCount, 1);
  });

  test("200 members sharing a phrase keyword are all notified", (testContext) => {
    const { database, scopeFor, createConversation } = createWorkspace(testContext);
    const agentIds = Array.from({ length: 200 }, (_, index) => `keyword-agent-${index}`);
    for (const agentId of agentIds) {
      database.prepare(
        `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
         VALUES (?, ?, ?, '', 'owner', 'owner@example.com', 1, 1)`,
      ).run(agentId, `owner/${agentId}`, agentId);
      database.prepare("INSERT INTO keywords (agent_id, keyword) VALUES (?, 'api key')").run(agentId);
    }
    createConversation("crowd", "public", ["writer", ...agentIds]);
    sendMessage(scopeFor("writer"), { to: "#crowd", text: "rotate the api key" });
    assert.equal(database.prepare("SELECT count(*) AS count FROM inbox WHERE reason = 'keyword'").get().count, 200);
  });
});

describe("message mutations", () => {
  for (const editedSeq of [1, 2]) {
    test(`editing thread message ${editedSeq} invalidates older thread jobs`, (testContext) => {
      const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
      const conversationId = createConversation("edits");
      const rootId = addMessage(conversationId, 1, { text: "root before edit" });
      addMessage(conversationId, 2, { rootId, text: "reply before edit" });
      const scope = scopeFor("writer");
      const version = database.prepare("SELECT thread_version FROM messages WHERE id = ?").get(rootId).thread_version;
      const initialJob = { op: "upsert", ws: scope.workspaceId, conv: conversationId, seq: 1, kind: "thread", version };
      assert.equal(buildDocument(scope.sql, scope.workspaceId, initialJob).action, "upsert");
      editMessage(scope, { message: `edits/${editedSeq}`, text: "first edited text" });
      assert.equal(buildDocument(scope.sql, scope.workspaceId, initialJob), null, "the job from before the edit must be stale");
      const firstJob = { ...scope.indexJobs.at(-1), ws: scope.workspaceId };
      assert.equal(firstJob.version, version + 1);
      assert.match(buildDocument(scope.sql, scope.workspaceId, firstJob).text, /first edited text/);
      editMessage(scope, { message: `edits/${editedSeq}`, text: "second edited text" });
      assert.equal(buildDocument(scope.sql, scope.workspaceId, firstJob), null, "the next edit must invalidate the prior edit job");
      const latestJob = { ...scope.indexJobs.at(-1), ws: scope.workspaceId };
      assert.equal(latestJob.version, version + 2);
      const document = buildDocument(scope.sql, scope.workspaceId, latestJob);
      assert.match(document.text, /second edited text/);
      assert.doesNotMatch(document.text, /first edited text/);
      assert.equal(database.prepare("SELECT reply_count FROM messages WHERE id = ?").get(rootId).reply_count, 1);
    });
  }

  test("deleting replies updates the root once and invalidates its queued thread version", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("deletions");
    const rootId = addMessage(conversationId, 1);
    addMessage(conversationId, 2, { rootId });
    addMessage(conversationId, 3, { rootId });
    database.prepare("INSERT INTO thread_follows (agent_id, root_id, state) VALUES ('reader', ?, 'on')").run(rootId);
    assert.equal(buildBrief(scopeFor("reader")).threads.length, 1);
    const writerScope = scopeFor("writer");
    deleteMessage(writerScope, { message: "deletions/3" });
    let root = database.prepare("SELECT * FROM messages WHERE id = ?").get(rootId);
    assert.equal(root.reply_count, 1);
    assert.equal(root.last_reply_at, 2);
    assert.equal(root.thread_version, 3);
    assert.equal(writerScope.indexJobs.at(-1).version, 3);
    const queuedJobs = writerScope.indexJobs.length;
    deleteMessage(writerScope, { message: "deletions/3" });
    assert.equal(writerScope.indexJobs.length, queuedJobs);
    deleteMessage(writerScope, { message: "deletions/2" });
    root = database.prepare("SELECT * FROM messages WHERE id = ?").get(rootId);
    assert.equal(root.reply_count, 0);
    assert.equal(root.last_reply_at, null);
    assert.equal(root.thread_version, 4);
    assert.deepEqual(buildBrief(scopeFor("reader")).threads, []);
  });

  test("archiving blocks edits, reaction changes and pin changes without mutations", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("archive");
    addMessage(conversationId, 1);
    const writerScope = scopeFor("writer");
    react(writerScope, { message: "archive/1", emoji: "eyes" });
    pin(writerScope, { message: "archive/1" });
    database.prepare("UPDATE conversations SET archived_at = 2 WHERE id = ?").run(conversationId);
    for (const mutation of [
      () => editMessage(writerScope, { message: "archive/1", text: "edited" }),
      () => react(writerScope, { message: "archive/1", emoji: "rocket" }),
      () => react(writerScope, { message: "archive/1", emoji: "eyes", remove: true }),
      () => pin(writerScope, { message: "archive/1" }),
      () => pin(writerScope, { message: "archive/1", remove: true }),
    ]) assert.throws(mutation, /archived/);
    assert.equal(database.prepare("SELECT text FROM messages").get().text, "matching content");
    assert.equal(database.prepare("SELECT count(*) AS count FROM reactions").get().count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM pins").get().count, 1);
    database.prepare("UPDATE conversations SET archived_at = NULL WHERE id = ?").run(conversationId);
    editMessage(writerScope, { message: "archive/1", text: "edited" });
    react(writerScope, { message: "archive/1", emoji: "eyes", remove: true });
    pin(writerScope, { message: "archive/1", remove: true });
    assert.equal(database.prepare("SELECT text FROM messages").get().text, "edited");
    assert.equal(database.prepare("SELECT reaction_count FROM messages").get().reaction_count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM pins").get().count, 0);
  });
});

test("owner lookup returns ten agents when more than ten match", (testContext) => {
  const { database, scopeFor } = createWorkspace(testContext);
  for (let index = 0; index < 9; index++) {
    database.prepare(
      `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
       VALUES (?, ?, ?, '', 'owner', 'owner@example.com', 1, 1)`,
    ).run(`agent-${index}`, `owner/agent-${index}`, `agent-${index}`);
  }
  const matches = lookup(scopeFor("reader"), { query: "owner", kind: "agent" }).results;
  assert.equal(matches.length, 10);
  assert.ok(matches.every((match) => match.id.startsWith("@owner/")));
});

describe("search page exposure", () => {
  test("logs each page, credits only shown IDs and preserves its cursor snapshot", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("search");
    const messageIds = [1, 2, 3, 4].map((seq) => addMessage(conversationId, seq));
    const readerScope = scopeFor("reader");
    const firstPage = await searchMessages(readerScope, { query: "in:#search", limit: 1 });
    assert.deepEqual(firstPage.results.map((message) => message.id), ["search/4"]);
    assert.deepEqual(JSON.parse(database.prepare("SELECT results FROM search_log").get().results), { results: [{ id: messageIds[3], rank: 1 }], top: [] });
    recordSearchActions(readerScope, "open", () => true);
    assert.deepEqual(database.prepare("SELECT message_id, rank FROM search_actions").all().map((row) => [row.message_id, row.rank]), [[messageIds[3], 1]]);
    addMessage(conversationId, 5);
    const secondPage = await searchMessages(readerScope, { cursor: firstPage.next_cursor, limit: 1 });
    assert.deepEqual(secondPage.results.map((message) => message.id), ["search/3"]);
    assert.deepEqual(database.prepare("SELECT results FROM search_log ORDER BY id").all().map((row) => JSON.parse(row.results).results), [[{ id: messageIds[3], rank: 1 }], [{ id: messageIds[2], rank: 2 }]]);
    recordSearchActions(readerScope, "open", () => true);
    assert.equal(database.prepare("SELECT used FROM channel_usefulness").get().used, 2);
    assert.equal(database.prepare("SELECT shown FROM channel_usefulness").get().shown, 2);
    const thirdPage = await searchMessages(readerScope, { cursor: secondPage.next_cursor, limit: 2 });
    assert.deepEqual(thirdPage.results.map((message) => message.id), ["search/2", "search/1"]);
    assert.equal(thirdPage.next_cursor, null);
  });

  test("cursor pages exclude deleted messages and lost private membership", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("private-search", "private");
    addMessage(conversationId, 1);
    addMessage(conversationId, 2);
    addMessage(conversationId, 3);
    const readerScope = scopeFor("reader");
    const firstPage = await searchMessages(readerScope, { query: "in:#private-search", limit: 1 });
    deleteMessage(scopeFor("writer"), { message: "private-search/2" });
    const secondPage = await searchMessages(readerScope, { cursor: firstPage.next_cursor, limit: 1 });
    assert.deepEqual(secondPage.results, []);
    leaveChannel(readerScope, { channel: "#private-search" });
    const thirdPage = await searchMessages(readerScope, { cursor: secondPage.next_cursor, limit: 1 });
    assert.deepEqual(thirdPage.results, []);
    const firstSearchId = database.prepare("SELECT min(id) AS id FROM search_log").get().id;
    assert.deepEqual(database.prepare("SELECT results FROM search_log ORDER BY id DESC LIMIT 2").all().map((row) => JSON.parse(row.results)), [{ search_id: firstSearchId, results: [], top: [] }, { search_id: firstSearchId, results: [], top: [] }]);
    assert.equal(database.prepare("SELECT shown FROM channel_usefulness").get().shown, 1);
  });

  test("cursors belong to their searching agent and expire with cache cleanup", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("expiration");
    addMessage(conversationId, 1);
    addMessage(conversationId, 2);
    const readerScope = scopeFor("reader");
    const firstPage = await searchMessages(readerScope, { query: "in:#expiration", limit: 1 });
    await assert.rejects(searchMessages(scopeFor("writer"), { cursor: firstPage.next_cursor }), /expired/);
    readerScope.now += SEARCH.cursorTtlMs + 1;
    await assert.rejects(searchMessages(readerScope, { cursor: firstPage.next_cursor }), /expired/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM meta WHERE key GLOB 'search_cursor:*'").get().count, 0);
  });

  test("displayed top results earn exposure but no action credit, while hidden candidates earn nothing", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("top-results");
    const messageIds = Array.from({ length: 15 }, (_, index) => addMessage(conversationId, index + 1));
    for (const messageId of messageIds.slice(0, 3)) {
      database.prepare("INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, 'writer', 1)").run(messageId);
    }
    const { WEIGHTS } = await import("../src/search/config.ts");
    const weights = Object.fromEntries(Object.keys(WEIGHTS).map((name) => [name, Number(name === "engagement")]));
    database.prepare("INSERT INTO meta (key, value) VALUES ('search_tuning', ?)").run(JSON.stringify({ weights }));
    const readerScope = scopeFor("reader");
    readerScope.env = {
      AI: { run: async () => ({ data: [[1]] }) },
      VECTORS: { query: async () => ({ matches: [] }) },
    };
    const firstPage = await searchMessages(readerScope, { query: "matching", sort: "recent", limit: 1 });
    assert.deepEqual(new Set(firstPage.top.map((message) => message.id)), new Set(["top-results/1", "top-results/2", "top-results/3"]));
    assert.deepEqual(firstPage.results.map((message) => message.id), ["top-results/15"]);
    const firstLog = database.prepare("SELECT id, results FROM search_log").get();
    const firstSearchId = firstLog.id;
    const shownPage = JSON.parse(firstLog.results);
    assert.equal(shownPage.top.length, 3);
    assert.deepEqual(shownPage.results, [{ id: messageIds[14], rank: 1 }]);
    recordSearchActions(readerScope, "save", (message) => message.id === messageIds[3]);
    assert.equal(database.prepare("SELECT count(*) AS count FROM search_actions").get().count, 0);
    const topOnlyId = shownPage.top[0].id;
    recordSearchActions(readerScope, "save", (message) => message.id === topOnlyId);
    recordSearchActions(readerScope, "save", (message) => message.id === topOnlyId);
    assert.equal(database.prepare("SELECT count(*) AS count FROM search_actions").get().count, 0);
    assert.equal(database.prepare("SELECT shown FROM channel_usefulness").get().shown, 4);
    assert.equal(database.prepare("SELECT used FROM channel_usefulness").get().used, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agent_affinity").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM channel_affinity").get().count, 0);
    const secondPage = await searchMessages(readerScope, { cursor: firstPage.next_cursor, limit: 1 });
    assert.equal(secondPage.top, undefined);
    assert.deepEqual(JSON.parse(database.prepare("SELECT results FROM search_log ORDER BY id DESC LIMIT 1").get().results), { search_id: firstSearchId, results: [{ id: messageIds[13], rank: 2 }], top: [] });
  });
  test("an action on a later page records its absolute rank", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("paged");
    const messageIds = Array.from({ length: 25 }, (_, index) => addMessage(conversationId, index + 1));
    const readerScope = scopeFor("reader");
    const firstPage = await searchMessages(readerScope, { query: "in:#paged", limit: 10 });
    const secondPage = await searchMessages(readerScope, { cursor: firstPage.next_cursor, limit: 10 });
    assert.equal(secondPage.results[0].id, "paged/15");
    const [firstLog, secondLog] = database.prepare("SELECT id, results FROM search_log ORDER BY id").all();
    assert.equal(JSON.parse(firstLog.results).search_id, undefined);
    assert.equal(JSON.parse(secondLog.results).search_id, firstLog.id);
    recordSearchActions(readerScope, "open", (message) => message.id === messageIds[14]);
    assert.deepEqual(database.prepare("SELECT rank FROM search_actions").all().map((row) => row.rank), [11]);
  });

  test("displayed top results do not shift the recency ranks", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("top-ranks");
    const messageIds = Array.from({ length: 15 }, (_, index) => addMessage(conversationId, index + 1));
    for (const messageId of messageIds.slice(0, 3)) {
      database.prepare("INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, 'writer', 1)").run(messageId);
    }
    const { WEIGHTS } = await import("../src/search/config.ts");
    const weights = Object.fromEntries(Object.keys(WEIGHTS).map((name) => [name, Number(name === "engagement")]));
    database.prepare("INSERT INTO meta (key, value) VALUES ('search_tuning', ?)").run(JSON.stringify({ weights }));
    const readerScope = scopeFor("reader");
    readerScope.env = {
      AI: { run: async () => ({ data: [[1]] }) },
      VECTORS: { query: async () => ({ matches: [] }) },
    };
    const firstPage = await searchMessages(readerScope, { query: "matching", sort: "recent", limit: 2 });
    assert.equal(firstPage.top.length, 3);
    assert.deepEqual(firstPage.results.map((message) => message.id), ["top-ranks/15", "top-ranks/14"]);
    recordSearchActions(readerScope, "open", (message) => message.id === messageIds[14] || message.id === messageIds[13]);
    assert.deepEqual(database.prepare("SELECT message_id, rank FROM search_actions ORDER BY rank").all().map((row) => [row.message_id, row.rank]), [[messageIds[14], 1], [messageIds[13], 2]]);
  });

  test("a message shown in both top and results counts once and records its results rank", async (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("both-lists");
    const messageIds = Array.from({ length: 15 }, (_, index) => addMessage(conversationId, index + 1));
    for (const messageId of messageIds.slice(0, 3)) {
      database.prepare("INSERT INTO pins (message_id, pinned_by, pinned_at) VALUES (?, 'writer', 1)").run(messageId);
    }
    const { WEIGHTS } = await import("../src/search/config.ts");
    const weights = Object.fromEntries(Object.keys(WEIGHTS).map((name) => [name, Number(name === "engagement")]));
    database.prepare("INSERT INTO meta (key, value) VALUES ('search_tuning', ?)").run(JSON.stringify({ weights }));
    const readerScope = scopeFor("reader");
    readerScope.env = {
      AI: { run: async () => ({ data: [[1]] }) },
      VECTORS: { query: async () => ({ matches: [] }) },
    };
    const firstPage = await searchMessages(readerScope, { query: "matching", sort: "recent", limit: 15 });
    assert.equal(firstPage.top.length, 3);
    assert.equal(firstPage.results.length, 15);
    assert.equal(database.prepare("SELECT shown FROM channel_usefulness").get().shown, 15);
    recordSearchActions(readerScope, "open", (message) => message.id === messageIds[0]);
    assert.deepEqual(database.prepare("SELECT rank FROM search_actions").all().map((row) => row.rank), [15]);
    assert.equal(database.prepare("SELECT used FROM channel_usefulness").get().used, 1);
  });

  test("legacy ID-array log rows rank results by position", (testContext) => {
    const { database, scopeFor, createConversation, addMessage } = createWorkspace(testContext);
    const conversationId = createConversation("legacy");
    const messageIds = [1, 2, 3].map((seq) => addMessage(conversationId, seq));
    const readerScope = scopeFor("reader");
    database.prepare("INSERT INTO search_log (agent_id, query, sort, results, created_at) VALUES ('reader', 'legacy', 'relevant', ?, ?)").run(JSON.stringify(messageIds), readerScope.now);
    recordSearchActions(readerScope, "open", (message) => message.id === messageIds[2]);
    assert.equal(database.prepare("SELECT rank FROM search_actions").get().rank, 3);
  });
});
