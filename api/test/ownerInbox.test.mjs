import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { addAgent, addConversation, createDatabase, createScope } from "./lib/sqlite.mjs";
import { LIMITS } from "../src/limits.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { IndexDelivery } from "../src/indexDelivery.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "cloudflare:workers") return nextResolve(specifier, context);
    return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
  },
});

const { checkInbox, markRead } = await import("../src/inbox.ts");
const { openChat } = await import("../src/conversations.ts");
const { deleteMessage, sendMessage } = await import("../src/messages.ts");
const { countUnreadOwnerMessages, newestOwnerMessage, ownerInboxMessages, sweepStrandedMessages } = await import("../src/ownerInbox.ts");
const { WorkspaceDO } = await import("../src/workspace.ts");
const { ToolError } = await import("../src/store.ts");

function createWorkspace(context) {
  const harness = createDatabase();
  context.after(() => harness.database.close());
  const now = Date.now();
  const agents = {};
  for (const id of ["author", "sleeper", "caller", "second", "stranger", "active", "revoked"]) {
    const isSibling = ["sleeper", "caller", "second", "active", "revoked"].includes(id);
    agents[id] = addAgent(harness.database, id, {
      owner: isSibling ? "shared" : id,
      lastActiveAt: now,
      revokedAt: id === "revoked" ? now : null,
    });
  }
  setDistinctOwnerHandles({ database: harness.database, agents });
  function scopeFor(agentId) {
    return createScope(harness.sql, agents[agentId], now);
  }
  function sendToOwner(text = "Please pick this up") {
    return sendMessage(scopeFor("author"), { to: "@team", text });
  }
  function messageIdOf(ref) {
    const [slug, sequence] = ref.split("/");
    return harness.database.prepare("SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.slug = ? AND m.seq = ?")
      .get(slug, Number(sequence)).id;
  }
  return { ...harness, agents, now, scopeFor, sendToOwner, messageIdOf };
}

function setDistinctOwnerHandles(workspace) {
  for (const agentId of ["author", "stranger"]) {
    const handle = `${agentId}/${agentId}`;
    workspace.database.prepare("UPDATE agents SET handle = ? WHERE id = ?").run(handle, agentId);
    workspace.agents[agentId].handle = handle;
  }
}

function attachWatchers(workspace, agentIds = ["caller", "second", "stranger"]) {
  const eventsByAgentId = new Map(agentIds.map((agentId) => [agentId, []]));
  const socketsByAgentId = new Map(agentIds.map((agentId) => [agentId, {
    readyState: WebSocket.OPEN,
    send(event) { eventsByAgentId.get(agentId).push(JSON.parse(event)); },
  }]));
  const durableWorkspace = Object.create(WorkspaceDO.prototype);
  durableWorkspace.sql = workspace.sql;
  durableWorkspace.env = {};
  let alarm = null;
  let transactionTail = Promise.resolve();
  durableWorkspace.ctx = {
    storage: {
      sql: workspace.sql,
      getAlarm: async () => alarm,
      setAlarm: async (time) => { alarm = time; },
      deleteAlarm: async () => { alarm = null; },
      transaction(invoke) {
        const result = transactionTail.then(async () => {
          const priorAlarm = alarm;
          workspace.database.exec("BEGIN");
          try {
            const output = await invoke();
            workspace.database.exec("COMMIT");
            return output;
          } catch (error) {
            workspace.database.exec("ROLLBACK");
            alarm = priorAlarm;
            throw error;
          }
        });
        transactionTail = result.catch(() => {});
        return result;
      },
      transactionSync(invoke) {
        workspace.database.exec("BEGIN");
        try {
          const output = invoke();
          workspace.database.exec("COMMIT");
          return output;
        } catch (error) {
          workspace.database.exec("ROLLBACK");
          throw error;
        }
      },
    },
    getWebSockets(agentId) { return agentId ? [socketsByAgentId.get(agentId)].filter(Boolean) : [...socketsByAgentId.values()]; },
    getTags(socket) { return [...socketsByAgentId].filter(([, candidate]) => candidate === socket).map(([agentId]) => agentId); },
  };
  durableWorkspace.indexDelivery = new IndexDelivery(durableWorkspace.ctx.storage, {
    sendBatch: (messages) => durableWorkspace.env.INDEX_QUEUE.sendBatch(messages),
  });
  workspace.database.prepare("INSERT INTO meta VALUES ('workspace_id', 'ws_test')").run();
  return { durableWorkspace, eventsByAgentId, socketsByAgentId };
}

function callerIdentity(workspace, agentId) {
  return {
    workspaceId: "ws_test",
    agent: workspace.agents[agentId].handle,
    grantId: `grant-${agentId}`,
    ownerSub: workspace.agents[agentId].owner_sub,
    ownerEmail: `${workspace.agents[agentId].handle.split("/")[0]}@example.com`,
    ownerName: "",
  };
}

test("migration 10 adds only owner messages, claims, reads and the owner cursor", (context) => {
  const ownerMigration = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE owner_messages"));
  const { database } = createDatabase(MIGRATIONS.slice(0, ownerMigration));
  context.after(() => database.close());
  addAgent(database, "existing");
  database.exec(MIGRATIONS[ownerMigration]);
  assert.equal(database.prepare("SELECT owner_push_cursor FROM agents").get().owner_push_cursor, 0);
  for (const table of ["owner_messages", "claims", "owner_reads"]) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
  }
  assert.match(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'owner_reads'").get().sql, /WITHOUT ROWID/);
});

test("owner message lookups by owner and time search the owner time index instead of scanning", (context) => {
  const workspace = createWorkspace(context);
  workspace.sendToOwner();
  checkInbox(workspace.scopeFor("caller"), {});
  newestOwnerMessage(workspace.sql, "shared", workspace.now, workspace.agents.caller.id);
  newestOwnerMessage(workspace.sql, "shared", workspace.now);
  markRead(workspace.scopeFor("caller"), { all: true });
  const ownerTimeLookups = workspace.queries.filter(({ query }) => /FROM owner_messages o\b[\s\S]*o\.owner_sub = \?1 AND o\.created_at > \?2/.test(query));
  assert.ok(ownerTimeLookups.length >= 4);
  for (const lookup of ownerTimeLookups) {
    const planSteps = workspace.explain(lookup);
    assert.ok(planSteps.some((step) => /SEARCH o USING (COVERING )?INDEX owner_messages_owner_time/.test(step)), planSteps.join("\n"));
    assert.ok(!planSteps.some((step) => /^SCAN o\b/.test(step)), planSteps.join("\n"));
  }
});

describe("direct owner messages", () => {
  test("reuses a single-member owner chat with real foreign keys and preserves bare-name errors", (context) => {
    const workspace = createWorkspace(context);
    setDistinctOwnerHandles(workspace);
    workspace.database.exec("PRAGMA foreign_keys = ON");
    const first = sendMessage(workspace.scopeFor("author"), { to: "@team", text: "Owner question" });
    const second = sendMessage(workspace.scopeFor("author"), { to: "@TEAM", text: "Another question" });
    assert.equal(first.conversation, second.conversation);
    assert.equal(first.queued_for, "@team");
    assert.match(first.hint, /carbon unit.*owner inbox.*first.*claim.*private chat/);
    const conversation = workspace.database.prepare("SELECT * FROM conversations WHERE slug = ?").get(first.conversation);
    assert.equal(conversation.kind, "dm");
    assert.equal(conversation.member_key, "owner:shared:author");
    assert.deepEqual(workspace.database.prepare("SELECT agent_id FROM members WHERE conversation_id = ?").all(conversation.id).map((member) => member.agent_id), ["author"]);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 2);
    assert.throws(() => sendMessage(workspace.scopeFor("author"), { to: "@missing", text: "Question" }), /no carbon unit @missing; lookup finds owners/);
    assert.throws(() => sendMessage(workspace.scopeFor("author"), { to: "@sleeper", text: "Question" }), /did you mean @team\/sleeper/);
    const revoked = addAgent(workspace.database, "retired", { owner: "retired-owner", revokedAt: workspace.now });
    workspace.database.prepare("UPDATE agents SET handle = 'retired/retired' WHERE id = ?").run(revoked.id);
    assert.equal(sendMessage(workspace.scopeFor("author"), { to: "@retired", text: "Question" }).queued_for, "@retired");
    const byChat = sendMessage(workspace.scopeFor("author"), { to: first.conversation, text: "Same owner chat" });
    assert.equal(byChat.queued_for, "@team");
  });

  test("every owner agent including later registrations sees it, excluding other owners, revoked agents and the author", (context) => {
    const workspace = createWorkspace(context);
    const sent = workspace.sendToOwner();
    workspace.agents.later = addAgent(workspace.database, "later", { owner: "shared" });
    for (const agentId of ["caller", "second", "active", "sleeper", "later"]) {
      const inbox = checkInbox(workspace.scopeFor(agentId), {});
      assert.equal(inbox.owner_inbox.items[0].message.id, sent.message);
      assert.equal(inbox.owner_inbox.items[0].queued_for, "@team");
      assert.equal(inbox.counts.owner, 1);
    }
    for (const agentId of ["author", "stranger", "revoked"]) assert.equal(checkInbox(workspace.scopeFor(agentId), {}).owner_inbox, undefined);
    const own = sendMessage(workspace.scopeFor("caller"), { to: "@team", text: "For my carbon unit" });
    assert.ok(!checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items.some(item => item.message.id === own.message));
    assert.ok(checkInbox(workspace.scopeFor("second"), {}).owner_inbox.items.some(item => item.message.id === own.message));
    assert.equal(checkInbox(workspace.scopeFor("second"), { cursor: "0.0" }).owner_inbox, undefined);
  });

  for (const exclusion of ["expired", "exact age boundary", "deleted"]) {
    test(`excludes ${exclusion} owner messages`, (context) => {
      const workspace = createWorkspace(context);
      const sent = workspace.sendToOwner();
      const messageId = workspace.messageIdOf(sent.message);
      if (exclusion === "deleted") workspace.database.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").run(workspace.now, messageId);
      if (exclusion !== "deleted") workspace.database.prepare("UPDATE owner_messages SET created_at = ? WHERE message_id = ?").run(workspace.now - LIMITS.ownerQueueMaxAgeMs - (exclusion === "expired" ? 1 : 0), messageId);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).counts.owner, undefined);
    });
  }

  for (const banKind of ["agent", "owner"]) {
    test(`hides owner messages while their author's ${banKind} is banned`, (context) => {
      const workspace = createWorkspace(context);
      const sent = workspace.sendToOwner();
      const subject = banKind === "agent" ? workspace.agents.author.id : workspace.agents.author.owner_sub;
      workspace.database.prepare("INSERT INTO bans (kind, subject, owner_sub, label, banned_at, banned_by, reason) VALUES (?, ?, ?, 'author', ?, 'stranger', 'spam')")
        .run(banKind, subject, workspace.agents.author.owner_sub, workspace.now);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).counts.owner, undefined);
      assert.equal(newestOwnerMessage(workspace.sql, workspace.agents.caller.owner_sub, workspace.now, workspace.agents.caller.id), undefined);
      workspace.database.prepare("DELETE FROM bans WHERE kind = ? AND subject = ?").run(banKind, subject);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
    });
  }

  test("keeps agent messages in their own inbox", (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Private question" });
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].message.id, sent.message);
  });

  test("uses twenty newest items and three earlier context messages in thread scope", (context) => {
    const workspace = createWorkspace(context);
    const prior = ["First", "Second", "Third", "Fourth"].map(text => workspace.sendToOwner(text).message);
    workspace.database.exec("DELETE FROM owner_messages");
    const sent = workspace.sendToOwner("Latest");
    assert.deepEqual(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].context.map(message => message.id), prior.slice(1));
    const root = sendMessage(workspace.scopeFor("author"), { to: sent.conversation, text: "Thread root", reply_to: prior[0] });
    const reply = sendMessage(workspace.scopeFor("author"), { to: sent.conversation, text: "Thread reply", reply_to: root.message });
    assert.deepEqual(ownerInboxMessages(workspace.scopeFor("caller"), { limit: 1 }).items[0].context.map(message => message.id), [root.message]);
    for (let index = 0; index < LIMITS.ownerQueuePage + 1; index++) {
      const senderId = `sender-${index}`;
      workspace.agents[senderId] = addAgent(workspace.database, senderId);
      sendMessage(workspace.scopeFor(senderId), { to: "@team", text: `Question ${index}` });
    }
    const inbox = checkInbox(workspace.scopeFor("caller"), {});
    assert.equal(inbox.owner_inbox.items.length, 20);
    assert.equal(inbox.owner_inbox.more, true);
    assert.equal(inbox.counts.owner, 24);
    assert.ok(workspace.messageIdOf(inbox.owner_inbox.items[0].message.id) > workspace.messageIdOf(reply.message));
  });

  test("truncates over-limit owner messages and their context to the inbox preview and hints", (context) => {
    const workspace = createWorkspace(context);
    const longText = "x".repeat(LIMITS.inboxTextPreviewChars + 50);
    workspace.sendToOwner(longText);
    workspace.database.exec("DELETE FROM owner_messages");
    workspace.sendToOwner(longText);
    const inbox = checkInbox(workspace.scopeFor("caller"), {});
    const [ownerItem] = inbox.owner_inbox.items;
    for (const view of [ownerItem.message, ownerItem.context[0]]) {
      assert.equal(view.text.length, LIMITS.inboxTextPreviewChars);
      assert.equal(view.text_truncated, true);
      assert.equal(view.text_length, longText.length);
    }
    assert.equal(inbox.items.length, 0);
    assert.match(inbox.hint, /pass the message ID as conversation to read_messages/);
  });
});

describe("per-agent owner reads", () => {
  test("named reads affect only the caller and all reads clear every visible item", (context) => {
    const workspace = createWorkspace(context);
    const first = workspace.sendToOwner("First");
    const second = workspace.sendToOwner("Second");
    assert.deepEqual(markRead(workspace.scopeFor("caller"), { messages: [first.message] }), { marked_read: { messages: [first.message] }, not_in_inbox: [] });
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).counts.owner, 1);
    assert.equal(checkInbox(workspace.scopeFor("second"), {}).counts.owner, 2);
    markRead(workspace.scopeFor("caller"), { all: true });
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
    assert.equal(checkInbox(workspace.scopeFor("second"), {}).counts.owner, 2);
    assert.throws(() => markRead(workspace.scopeFor("stranger"), { messages: [second.message] }), /not found/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_reads WHERE agent_id = 'stranger'").get().count, 0);
  });
});

describe("claim by reply", () => {
  test("first sibling wins, marks its owner item read and sends the author a private notice", (context) => {
    const workspace = createWorkspace(context);
    const sent = workspace.sendToOwner();
    const claimed = sendMessage(workspace.scopeFor("caller"), { to: `@${workspace.agents.author.handle}`, reply_to: sent.message, text: "I can handle this." });
    assert.equal(claimed.claimed, sent.message);
    assert.notEqual(claimed.message, sent.message);
    assert.equal(claimed.thread, undefined);
    const claim = workspace.database.prepare("SELECT * FROM claims").get();
    assert.equal(claim.agent_id, "caller");
    assert.equal(claim.claimed_at, workspace.now);
    const originalInbox = workspace.database.prepare("SELECT read_at FROM owner_reads WHERE agent_id = 'caller' AND message_id = ?").get(claim.message_id);
    assert.equal(originalInbox.read_at, workspace.now);
    const notice = checkInbox(workspace.scopeFor("author"), {}).items.find((item) => item.message.id === claimed.message);
    assert.equal(notice.reason, "dm");
    assert.equal(notice.message.author, "@team/caller");
    assert.equal(notice.conversation, claimed.conversation);
    assert.equal(notice.message.text, `Picking up ${sent.message}, which you sent to @team.\n\nI can handle this.`);
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
    assert.equal(checkInbox(workspace.scopeFor("second"), {}).owner_inbox.items[0].claimed_by, "@team/caller");
    markRead(workspace.scopeFor("second"), { messages: [sent.message] });
    assert.equal(checkInbox(workspace.scopeFor("second"), {}).owner_inbox, undefined);
    const chatMembers = workspace.database.prepare("SELECT agent_id FROM members WHERE conversation_id = (SELECT id FROM conversations WHERE slug = ?) ORDER BY agent_id")
      .all(claimed.conversation).map((member) => member.agent_id);
    assert.deepEqual(chatMembers, ["author", "caller"]);
    assert.throws(() => sendMessage(workspace.scopeFor("second"), { to: `@${workspace.agents.author.handle}`, reply_to: sent.message, text: "I can handle this." }),
      { name: "Error", message: `${sent.message} was already claimed by @team/caller at ${new Date(workspace.now).toISOString()}; it no longer needs an answer` });
    assert.throws(() => workspace.database.prepare("INSERT INTO claims (message_id, agent_id, claimed_at) VALUES (?, 'caller', ?)").run(claim.message_id, workspace.now), /UNIQUE constraint/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 1);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'author'").get().count, 1);
  });

  test("preserves the hidden conversation error for messages outside the caller's queue", (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/active", text: "For an active agent" });
    const foreign = workspace.sendToOwner();
    for (const [agentId, ref] of [["caller", sent.message], ["stranger", foreign.message]]) {
      const expectedError = `chat ${ref.split("/")[0]} not found; start_chat returns the chat ID`;
      assert.throws(() => sendMessage(workspace.scopeFor(agentId), { to: `@${workspace.agents.author.handle}`, reply_to: ref, text: "Answer" }),
        (error) => error instanceof ToolError && error.message === expectedError);
      assert.throws(() => sendMessage(workspace.scopeFor(agentId), { to: `@${workspace.agents.author.handle}`, reply_to: `${ref.split("/")[0]}/999`, text: "Answer" }),
        (error) => error instanceof ToolError && error.message === expectedError);
    }
    assert.throws(() => sendMessage(workspace.scopeFor("caller"), { to: `@${workspace.agents.author.handle}`, reply_to: "missing/1", text: "Answer" }), /channel #missing not found/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 0);
  });

  test("requires the queued author's handle for hidden and visible messages", (context) => {
    const workspace = createWorkspace(context);
    const hidden = workspace.sendToOwner();
    addConversation(workspace.database, "general", ["author", "caller", "sleeper"]);
    const visible = sendMessage(workspace.scopeFor("author"), { to: "#general", text: "@team Help" });
    for (const ref of [hidden.message, visible.message]) {
      for (const to of ["@team/stranger", "@team", "#general", "@missing/agent", "#missing", hidden.conversation]) {
        if (ref === visible.message && to === "#general") continue;
        assert.throws(() => sendMessage(workspace.scopeFor("caller"), { to, reply_to: ref, text: "Answer" }),
          (error) => error instanceof ToolError && error.message === `send to: '@author/author' to claim ${ref}`);
      }
    }
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 0);
  });

  test("rejects an oversized pickup notice before creating a claim or chat or marking inbox rows", (context) => {
    const workspace = createWorkspace(context);
    const sent = workspace.sendToOwner();
    const beforeConversationCount = workspace.database.prepare("SELECT count(*) AS count FROM conversations").get().count;
    const beforeMessageCount = workspace.database.prepare("SELECT count(*) AS count FROM messages").get().count;
    assert.throws(() => sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: sent.message, text: "x".repeat(LIMITS.messageLength) }),
      (error) => error instanceof ToolError && /pickup notice.*limit/.test(error.message));
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 0);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM conversations").get().count, beforeConversationCount);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM messages").get().count, beforeMessageCount);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_reads").get().count, 0);
  });

  test("same-conversation replies keep their thread even when the message is queued or claimed", (context) => {
    const workspace = createWorkspace(context);
    addConversation(workspace.database, "general", ["author", "caller", "second", "sleeper"]);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text: "@team Help" });
    const reply = sendMessage(workspace.scopeFor("caller"), { to: "#general", reply_to: sent.message, text: "Thread answer" });
    assert.equal(reply.claimed, undefined);
    assert.equal(reply.thread, `${sent.message}/t`);
    const claimed = sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: sent.message, text: "Private answer" });
    assert.equal(claimed.claimed, sent.message);
    const secondReply = sendMessage(workspace.scopeFor("second"), { to: "#general", reply_to: reply.message, text: "Another thread answer" });
    assert.equal(secondReply.claimed, undefined);
    assert.equal(secondReply.thread, reply.thread);
    const threadMessage = workspace.database.prepare("SELECT text, thread_root_id FROM messages WHERE id = ?").get(workspace.messageIdOf(secondReply.message));
    assert.equal(threadMessage.text, "Another thread answer");
    assert.equal(threadMessage.thread_root_id, workspace.messageIdOf(sent.message));
  });

  test("normal mismatched replies retain the existing error", (context) => {
    const workspace = createWorkspace(context);
    addConversation(workspace.database, "general", ["author", "caller"]);
    addConversation(workspace.database, "other", ["caller"]);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text: "No queue" });
    assert.throws(() => sendMessage(workspace.scopeFor("caller"), { to: "#other", reply_to: sent.message, text: "Answer" }),
      { message: `${sent.message} is in #general, not #other; set to: '#general'` });
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 0);
  });

});

describe("workspace tool transactions", () => {
  test("send_message flushes sibling watchers and competing replies produce one notice", async (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    watchers.durableWorkspace.workspaceDomain = "example.com";
    watchers.durableWorkspace.env.INDEX_QUEUE = { async sendBatch() {} };
    const sent = await watchers.durableWorkspace.tool("send_message", callerIdentity(workspace, "author"), {
      to: "@team", text: "Please pick this up",
    });
    assert.equal(sent.error, undefined);
    assert.equal(watchers.eventsByAgentId.get("caller")[0].reason, "owner");
    const claims = await Promise.all(["caller", "second"].map((agentId) => watchers.durableWorkspace.tool("send_message", callerIdentity(workspace, agentId), {
      to: "@author/author", reply_to: sent.output.message, text: "I can handle this.",
    })));
    assert.equal(claims.filter((claim) => claim.output).length, 1);
    assert.match(claims.find((claim) => claim.error).error, /was already claimed by @team\/(caller|second) at/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 1);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'author'").get().count, 1);
  });

  test("a failed sender notice rolls back both the claim and the original inbox read", async (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    watchers.durableWorkspace.workspaceDomain = "example.com";
    watchers.durableWorkspace.env.INDEX_QUEUE = { async sendBatch() {} };
    const sent = workspace.sendToOwner();
    const chat = openChat(workspace.scopeFor("caller"), ["author"]);
    workspace.database.prepare("UPDATE conversations SET archived_at = ? WHERE id = ?").run(workspace.now, chat.id);
    const claim = await watchers.durableWorkspace.tool("send_message", callerIdentity(workspace, "caller"), { to: "@author/author", reply_to: sent.message, text: "I can handle this." });
    assert.match(claim.error, /archived/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 0);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_reads").get().count, 0);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM inbox WHERE agent_id = 'author'").get().count, 0);
  });
});

describe("owner mentions", () => {
  for (const [name, text] of [
    ["inline code", "`@team`"],
    ["backtick fences", "```\n@team\n```"],
    ["tilde fences", "~~~\n@team\n~~~"],
    ["quoted list fences", "> - ```\n> @team\n> ```"],
    ["URL tokens", "https://example.com/?owner=@team"],
    ["a URL glued to the mention", "@teamhttps://x"],
    ["a URL glued after a dot", "ping @team.https://x.io/a"],
  ]) {
    test(`ignores owner mentions inside ${name}`, (context) => {
      const workspace = createWorkspace(context);
      addConversation(workspace.database, "general", ["author"]);
      const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text });
      assert.equal(sent.queued_for, undefined);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
      assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
    });
  }

  for (const [name, text] of [
    ["prose next to inline code", "ask @team about `x`"],
    ["escaped backticks", "\\`@team\\`"],
    ["unmatched backticks", "`@team"],
  ]) {
    test(`queues owner mentions in ${name}`, (context) => {
      const workspace = createWorkspace(context);
      addConversation(workspace.database, "general", ["author"]);
      const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text });
      assert.deepEqual(sent.queued_for, ["@team"]);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
    });
  }

  test("queues every mentioned owner and keeps one claim per owner", (context) => {
    const workspace = createWorkspace(context);
    setDistinctOwnerHandles(workspace);
    addConversation(workspace.database, "general", ["author"]);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text: "@team @stranger" });
    assert.deepEqual(sent.queued_for, ["@team", "@stranger"]);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE message_id = ?").get(workspace.messageIdOf(sent.message)).count, 2);
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
    assert.equal(checkInbox(workspace.scopeFor("stranger"), {}).owner_inbox.items[0].message.id, sent.message);
    sendMessage(workspace.scopeFor("caller"), { to: `@${workspace.agents.author.handle}`, reply_to: sent.message, text: "I can handle this." });
    assert.equal(checkInbox(workspace.scopeFor("active"), {}).owner_inbox.items[0].claimed_by, "@team/caller");
    assert.equal(checkInbox(workspace.scopeFor("stranger"), {}).owner_inbox.items[0].message.id, sent.message);
    sendMessage(workspace.scopeFor("stranger"), { to: `@${workspace.agents.author.handle}`, reply_to: sent.message, text: "I can handle this." });
    assert.equal(checkInbox(workspace.scopeFor("stranger"), {}).owner_inbox, undefined);
    assert.throws(() => sendMessage(workspace.scopeFor("second"), { to: `@${workspace.agents.author.handle}`, reply_to: sent.message, text: "I can handle this." }), /already claimed by @team\/caller/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM claims").get().count, 2);
  });

  for (const text of ["ping @team.", "ask @team, please", "need help from @team...", "@team.-"]) {
    test(`queues punctuation in ${text}`, (context) => {
      const workspace = createWorkspace(context);
      addConversation(workspace.database, "general", ["author"]);
      const sent = sendMessage(workspace.scopeFor("author"), { to: "#general", text });
      assert.deepEqual(sent.queued_for, ["@team"]);
      assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
    });
  }
  test("ignores private mentions, broadcasts, package names, email fragments, unknown and own owners", (context) => {
    const workspace = createWorkspace(context);
    setDistinctOwnerHandles(workspace);
    for (const ownerName of ["channel", "here"]) {
      const agent = addAgent(workspace.database, `${ownerName}-agent`);
      workspace.database.prepare("UPDATE agents SET handle = ? WHERE id = ?").run(`${ownerName}/agent`, agent.id);
    }
    addConversation(workspace.database, "general", ["author", "caller"]);
    addConversation(workspace.database, "private", ["author", "caller"], "private");
    for (const text of ["@channel", "@here", "@types/node", "@types", "a@team", "@team/missing", "@author", "@team/", "@unknown", "@team.example/x", "@team.io"]) {
      assert.equal(sendMessage(workspace.scopeFor("author"), { to: "#general", text }).queued_for, undefined);
    }
    assert.equal(sendMessage(workspace.scopeFor("author"), { to: "#private", text: "@team" }).queued_for, undefined);
    assert.equal(sendMessage(workspace.scopeFor("author"), { to: "@team/caller", text: "@team" }).queued_for, undefined);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
  });
});

describe("owner inbox sender cap", () => {
  function sendToOwner(workspace, agentId, text) {
    return sendMessage(workspace.scopeFor(agentId), { to: "@team", text });
  }

  test("stops queueing past the per-sender cap, hints, and frees a slot on claim", (context) => {
    const workspace = createWorkspace(context);
    setDistinctOwnerHandles(workspace);
    const queued = [];
    for (let index = 0; index < LIMITS.ownerQueuePerSender; index++) queued.push(sendToOwner(workspace, "author", `Question ${index}`));
    assert.ok(queued.every((sent) => sent.queued_for === "@team"));
    const overCap = sendToOwner(workspace, "author", "One more");
    assert.equal(overCap.queued_for, undefined);
    assert.match(overCap.hint, /not queued for @team/);
    assert.ok(!checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items.some((item) => item.message.id === overCap.message));
    assert.equal(sendToOwner(workspace, "stranger", "Different sender").queued_for, "@team");
    sendMessage(workspace.scopeFor("caller"), { to: `@${workspace.agents.author.handle}`, reply_to: queued[0].message, text: "I can handle this." });
    assert.equal(sendToOwner(workspace, "author", "After a claim").queued_for, "@team");
  });

  function fillSenderCap(workspace, agentId) {
    return Array.from({ length: LIMITS.ownerQueuePerSender }, (_, index) => sendToOwner(workspace, agentId, `Question ${index}`));
  }

  function addSecondAuthorAgent(workspace) {
    workspace.agents.authorSecond = addAgent(workspace.database, "authorSecond", { owner: "author", lastActiveAt: workspace.now });
    workspace.database.prepare("UPDATE agents SET handle = 'author/second' WHERE id = 'authorSecond'").run();
    workspace.agents.authorSecond.handle = "author/second";
  }

  test("agents of one sending carbon unit share the cap", (context) => {
    const workspace = createWorkspace(context);
    addSecondAuthorAgent(workspace);
    fillSenderCap(workspace, "author");
    assert.equal(sendToOwner(workspace, "authorSecond", "From another agent").queued_for, undefined);
  });

  test("author deletes of every queued message free the whole cap", (context) => {
    const workspace = createWorkspace(context);
    for (const queued of fillSenderCap(workspace, "author")) deleteMessage(workspace.scopeFor("author"), { message: queued.message });
    assert.equal(sendToOwner(workspace, "author", "After deleting all").queued_for, "@team");
  });

  test("a moderator delete of a queued message frees a cap slot", (context) => {
    const workspace = createWorkspace(context);
    const [firstQueued] = fillSenderCap(workspace, "author");
    workspace.database.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").run(workspace.now, workspace.messageIdOf(firstQueued.message));
    assert.equal(sendToOwner(workspace, "author", "After a moderator delete").queued_for, "@team");
  });

  test("a different sending carbon unit keeps its own cap and a claim frees a slot", (context) => {
    const workspace = createWorkspace(context);
    addSecondAuthorAgent(workspace);
    const [firstQueued] = fillSenderCap(workspace, "author");
    assert.equal(sendToOwner(workspace, "stranger", "Different carbon unit").queued_for, "@team");
    sendMessage(workspace.scopeFor("caller"), { to: `@${workspace.agents.author.handle}`, reply_to: firstQueued.message, text: "I can handle this." });
    assert.equal(sendToOwner(workspace, "authorSecond", "After a claim").queued_for, "@team");
  });

});
describe("owner pushes", () => {
  test("wakes affected owner watchers once per message and never repeats on reconnect", async (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    const durable = watchers.durableWorkspace;
    durable.workspaceDomain = "example.com";
    durable.env.INDEX_QUEUE = { async sendBatch() {} };
    for (const text of ["First", "Second"]) {
      const queryStart = workspace.queries.length;
      const sent = await durable.tool("send_message", callerIdentity(workspace, "author"), { to: "@team", text });
      const newestQueries = workspace.queries.slice(queryStart).filter(({ query }) => query.includes("ORDER BY m.id DESC LIMIT 1"));
      assert.equal(newestQueries.length, 1);
      assert.equal(sent.error, undefined);
      const [conversationSlug, seq] = sent.output.message.split("/");
      const messageId = workspace.database.prepare("SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.slug = ? AND m.seq = ?").get(conversationSlug, Number(seq)).id;
      const expected = { cursor: messageId, reason: "owner", conversation: sent.output.conversation, message: sent.output.message, from: "@author/author", queued_for: "@team" };
      for (const agentId of ["caller", "second"]) assert.deepEqual(watchers.eventsByAgentId.get(agentId).at(-1), expected);
      assert.equal(watchers.eventsByAgentId.get("stranger").length, 0);
    }
    for (const agentId of ["caller", "second"]) {
      assert.equal(watchers.eventsByAgentId.get(agentId).length, 2);
      durable.flushPending(agentId);
      assert.equal(watchers.eventsByAgentId.get(agentId).length, 2);
    }
  });

  test("overlapping sends each push once while index delivery is pending", async (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    const durable = watchers.durableWorkspace;
    durable.workspaceDomain = "example.com";
    let finishDelivery;
    let notifyBothMessages;
    let queueCalls = 0;
    const bothMessagesPosted = new Promise(resolve => { notifyBothMessages = resolve; });
    const callerSocket = watchers.socketsByAgentId.get("caller");
    const sendEvent = callerSocket.send;
    callerSocket.send = (event) => {
      sendEvent(event);
      if (watchers.eventsByAgentId.get("caller").length === 2) notifyBothMessages();
    };
    durable.env.INDEX_QUEUE = {
      sendBatch() {
        queueCalls++;
        return queueCalls === 1 ? new Promise(resolve => { finishDelivery = resolve; }) : Promise.resolve();
      },
    };
    const sends = ["author", "stranger"].map(agentId => durable.tool("send_message", callerIdentity(workspace, agentId), { to: "@team", text: "Question" }));
    await bothMessagesPosted;
    assert.equal(queueCalls,1);
    finishDelivery();
    const postedMessages = await Promise.all(sends);
    assert.ok(postedMessages.every(posted => !posted.error));
    assert.equal(queueCalls,2);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM pending_index_jobs").get().count,0);
    for (const agentId of ["caller", "second"]) {
      const events = watchers.eventsByAgentId.get(agentId);
      assert.equal(events.length, 2);
      assert.deepEqual(new Set(events.map(event => event.message)), new Set(postedMessages.map(posted => posted.output.message)));
    }
  });

  test("reconnect delivers unread owner work alongside an agent inbox push", (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    const sent = workspace.sendToOwner();
    sendMessage(workspace.scopeFor("author"), { to: "@team/caller", text: "Direct" });
    watchers.durableWorkspace.flushPending("caller");
    assert.deepEqual(watchers.eventsByAgentId.get("caller").map(event => event.reason), ["dm", "owner"]);
    assert.equal(watchers.eventsByAgentId.get("caller")[1].message, sent.message);
    watchers.durableWorkspace.flushPending("caller");
    assert.equal(watchers.eventsByAgentId.get("caller").length, 2);
  });

  test("reconnect checks the caller's unread items when the newest item is read or authored by the caller", (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    const first = workspace.sendToOwner("Unread");
    const second = workspace.sendToOwner("Read");
    markRead(workspace.scopeFor("caller"), { messages: [second.message] });
    sendMessage(workspace.scopeFor("caller"), { to: "@team", text: "Mine" });
    watchers.durableWorkspace.flushPending("caller");
    assert.equal(watchers.eventsByAgentId.get("caller")[0].message, first.message);
    watchers.durableWorkspace.flushPending("caller");
    assert.equal(watchers.eventsByAgentId.get("caller").length, 1);
  });

  test("reconnect skips an owner item a sibling already claimed and wakes for an older unclaimed one", (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace);
    const unclaimed = workspace.sendToOwner("Still open");
    const claimed = workspace.sendToOwner("Doorbell test");
    sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: claimed.message, text: "ding dong" });
    watchers.durableWorkspace.flushPending("second");
    assert.deepEqual(watchers.eventsByAgentId.get("second").map(event => event.message), [unclaimed.message]);
  });

  test("a send that queues nothing new never wakes siblings for a claimed owner item", async (context) => {
    const workspace = createWorkspace(context);
    const watchers = attachWatchers(workspace, ["second"]);
    const durable = watchers.durableWorkspace;
    durable.workspaceDomain = "example.com";
    durable.env.INDEX_QUEUE = { async sendBatch() {} };
    const claimed = workspace.sendToOwner("Doorbell test");
    sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: claimed.message, text: "ding dong" });
    durable.flushWatchers(new Set([workspace.agents.second.owner_sub]));
    assert.equal(watchers.eventsByAgentId.get("second").length, 0);
  });

  test("admin reads an owner chat with the owner as its title and only the sender as its member", async (context) => {
    const { adminList, adminRead } = await import("../src/adminData.ts");
    const workspace = createWorkspace(context);
    setDistinctOwnerHandles(workspace);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team", text: "Owner question" });
    const adminContext = { sql: workspace.sql, now: workspace.now, sub: "author", audit() {} };
    const listed = adminList(adminContext, { scope: "mine", kind: "private" });
    assert.equal(listed.ok, true);
    assert.equal(listed.value.conversations[0].name, "@team");
    assert.deepEqual(listed.value.conversations[0].members, ["author/author"]);
    const read = adminRead(adminContext, { conversation: sent.conversation });
    assert.equal(read.ok, true);
    assert.equal(read.value.conversation.name, "@team");
  });
});

describe("stranded messages", () => {
  function endSession(workspace, agentId = "sleeper", lastActiveAt = workspace.now - LIMITS.agentNameHoldMs) {
    workspace.database.prepare("UPDATE agents SET last_active_at = ? WHERE id = ?").run(lastActiveAt, agentId);
    workspace.agents[agentId].last_active_at = lastActiveAt;
  }

  function scopeWithLiveness(workspace, agentId = "author", listeningAgentIds = new Set()) {
    return {
      ...workspace.scopeFor(agentId),
      hasSessionEnded: agent => workspace.now - agent.last_active_at >= LIMITS.agentNameHoldMs && !listeningAgentIds.has(agent.id),
    };
  }

  function sweep(workspace, hasSessionEnded = scopeWithLiveness(workspace).hasSessionEnded) {
    return sweepStrandedMessages(workspace.sql, workspace.now, hasSessionEnded);
  }

  test("migration preserves direct owner items with NULL provenance and references agents", (context) => {
    const migrationIndex = MIGRATIONS.findIndex(migration => migration.includes("ALTER TABLE owner_messages ADD COLUMN stranded_from"));
    const harness = createDatabase(MIGRATIONS.slice(0, migrationIndex));
    context.after(() => harness.database.close());
    addAgent(harness.database, "author");
    addAgent(harness.database, "recipient", { owner: "shared" });
    const conversation = addConversation(harness.database, "existing", ["author"]);
    const existingMessage = harness.database.prepare("INSERT INTO messages (conversation_id, seq, author_id, text, created_at, word_count) VALUES (?, 1, 'author', 'Direct owner item', 1, 3) RETURNING id").get(conversation.id);
    harness.database.prepare("INSERT INTO owner_messages (message_id, owner_sub, created_at) VALUES (?, 'shared', 1)").run(existingMessage.id);
    harness.database.exec(MIGRATIONS[migrationIndex]);
    assert.equal(harness.database.prepare("SELECT stranded_from FROM owner_messages").get().stranded_from, null);
    harness.database.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => harness.database.prepare("UPDATE owner_messages SET stranded_from = 'missing'").run(), /FOREIGN KEY constraint/);
  });

  test("DM to an ended session keeps the original inbox row and returns rerouted provenance", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const senderScope = scopeWithLiveness(workspace);
    const sent = sendMessage(senderScope, { to: "@team/sleeper", text: "Please help" });
    assert.deepEqual(sent.rerouted, [{ to: "@team", recipient: "@team/sleeper", inactive_since: new Date(workspace.agents.sleeper.last_active_at).toISOString() }]);
    assert.match(sent.hint, /sessions have ended.*carbon unit.*owner inbox/);
    assert.deepEqual(senderScope.queuedOwnerSubs, new Set(["shared"]));
    const queued = workspace.database.prepare("SELECT * FROM owner_messages").get();
    assert.equal(queued.stranded_from, "sleeper");
    assert.equal(queued.owner_sub, "shared");
    assert.equal(queued.created_at, workspace.now);
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].message.id, sent.message);
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
  });

  for (const state of ["active", "listening", "missing callback"]) {
    test(`${state} recipient does not reroute`, (context) => {
      const workspace = createWorkspace(context);
      if (state !== "active") endSession(workspace);
      const senderScope = state === "missing callback" ? workspace.scopeFor("author") : scopeWithLiveness(workspace, "author", new Set(state === "listening" ? ["sleeper"] : []));
      const sent = sendMessage(senderScope, { to: "@team/sleeper", text: "Please help" });
      assert.equal(sent.rerouted, undefined);
      assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
    });
  }

  test("same-owner sender never reroutes at send or sweep", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const sent = sendMessage(scopeWithLiveness(workspace, "caller"), { to: "@team/sleeper", text: "Sibling work" });
    assert.equal(sent.rerouted, undefined);
    assert.deepEqual(sweep(workspace), new Set());
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
  });

  test("public direct mention of an ended nonmember queues once for its owner", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    addConversation(workspace.database, "general", ["author"]);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "#general", text: "@team/sleeper please help" });
    assert.equal(sent.rerouted[0].recipient, "@team/sleeper");
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].reason, "mention");
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].stranded_from, "@team/sleeper");
    assert.deepEqual(sweep(workspace), new Set());
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 1);
  });

  test("hidden private mentions and muted DMs do not reroute without an inbox row", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    addConversation(workspace.database, "private", ["author"], "private");
    const mention = sendMessage(scopeWithLiveness(workspace), { to: "#private", text: "@team/sleeper help" });
    assert.deepEqual(mention.not_notified, ["@team/sleeper"]);
    assert.equal(mention.rerouted, undefined);
    const chat = openChat(workspace.scopeFor("author"), ["sleeper"]);
    workspace.database.prepare("INSERT INTO prefs (agent_id, conversation_id, muted) VALUES ('sleeper', ?, 1)").run(chat.id);
    const muted = sendMessage(scopeWithLiveness(workspace), { to: chat.slug, text: "Muted question" });
    assert.equal(muted.rerouted, undefined);
    assert.deepEqual(sweep(workspace), new Set());
  });

  test("stranded copies have their own per-sender cap and never consume direct-owner slots", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const strandedRefs = [];
    for (let index = 0; index < LIMITS.ownerQueuePerSender + 2; index++) {
      const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: `Stranded question ${index}` });
      assert.equal(sent.rerouted?.length, index < LIMITS.ownerQueuePerSender ? 1 : undefined);
      strandedRefs.push(sent.message);
    }
    assert.deepEqual(sweep(workspace), new Set());
    for (let index = 0; index < LIMITS.ownerQueuePerSender; index++) assert.equal(workspace.sendToOwner(`Direct question ${index}`).queued_for, "@team");
    assert.equal(workspace.sendToOwner("Over cap").queued_for, undefined);
    assert.equal(sendMessage(scopeWithLiveness(workspace, "stranger"), { to: "@team/sleeper", text: "Another sender" }).rerouted.length, 1);
    deleteMessage(workspace.scopeFor("author"), { message: strandedRefs[0] });
    assert.equal(sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Freed slot" }).rerouted.length, 1);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").get().count, LIMITS.ownerQueuePerSender + 2);
    assert.equal(workspace.queries.filter(({ query }) => query.includes("sender.owner_sub = ?3")).length, LIMITS.ownerQueuePerSender + 1);
  });

  test("stranded cap counts one sending carbon unit across every ended agent of the receiving carbon unit", (context) => {
    const workspace = createWorkspace(context);
    const endedAgentIds = ["sleeper", "second", "active"];
    for (const agentId of endedAgentIds) endSession(workspace, agentId);
    for (const agentId of endedAgentIds) {
      assert.equal(sendMessage(scopeWithLiveness(workspace), { to: `@team/${agentId}`, text: `Question for ${agentId}` }).rerouted.length, 1);
    }
    for (const agentId of endedAgentIds) {
      assert.equal(sendMessage(scopeWithLiveness(workspace), { to: `@team/${agentId}`, text: `Second question for ${agentId}` }).rerouted, undefined);
    }
    assert.deepEqual(sweep(workspace), new Set());
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").get().count, LIMITS.ownerQueuePerSender);
  });

  test("sweep caps stranded copies per sending carbon unit across every ended agent of the receiving carbon unit", (context) => {
    const workspace = createWorkspace(context);
    const endedAgentIds = ["sleeper", "second", "active"];
    for (const agentId of endedAgentIds) {
      for (let index = 0; index < 2; index++) sendMessage(workspace.scopeFor("author"), { to: `@team/${agentId}`, text: `Question ${index} for ${agentId}` });
    }
    for (const agentId of endedAgentIds) endSession(workspace, agentId);
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    assert.deepEqual(sweep(workspace), new Set());
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").get().count, LIMITS.ownerQueuePerSender);
  });

  test("a public message naming the owner and its ended agent keeps the direct owner item and reroutes nothing", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    addConversation(workspace.database, "general", ["author"]);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "#general", text: "@team @team/sleeper please help" });
    assert.deepEqual(sent.queued_for, ["@team"]);
    assert.equal(sent.rerouted, undefined);
    const queued = workspace.database.prepare("SELECT * FROM owner_messages").all();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].stranded_from, null);
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).owner_inbox.items[0].message.id, sent.message);
    assert.ok(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].context);
  });

  test("a public mention of two ended agents of one carbon unit reroutes only the copy it stored", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace, "sleeper");
    endSession(workspace, "second");
    addConversation(workspace.database, "general", ["author"]);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "#general", text: "@team/sleeper @team/second please help" });
    assert.equal(sent.rerouted.length, 1);
    const queued = workspace.database.prepare("SELECT stranded_from FROM owner_messages").all();
    assert.deepEqual(queued.map(row => `@team/${row.stranded_from}`), [sent.rerouted[0].recipient]);
  });

  test("every ended agent mentioned in one stranded message is hidden from its copy and claims it by answering", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace, "sleeper");
    endSession(workspace, "second");
    const general = addConversation(workspace.database, "general", ["author"]);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "#general", text: "@team/sleeper @team/second please help" });
    const otherMentionedAgentId = sent.rerouted[0].recipient === "@team/sleeper" ? "second" : "sleeper";
    const otherMentionedScope = workspace.scopeFor(otherMentionedAgentId);
    assert.equal(ownerInboxMessages(otherMentionedScope, { limit: 20 }).items.length, 0);
    assert.equal(countUnreadOwnerMessages(otherMentionedScope), 0);
    assert.equal(newestOwnerMessage(workspace.sql, "shared", workspace.now, otherMentionedAgentId), undefined);
    assert.equal(ownerInboxMessages(workspace.scopeFor("caller"), { limit: 20 }).items[0].message.id, sent.message);
    workspace.database.prepare("INSERT INTO members VALUES (?, ?, 1)").run(general.id, otherMentionedAgentId);
    sendMessage(otherMentionedScope, { to: "#general", text: "Back now, on it" });
    assert.equal(ownerInboxMessages(workspace.scopeFor("caller"), { limit: 20 }).items[0].claimed_by, `@team/${otherMentionedAgentId}`);
  });

  test("sweep caps stranded copies per sending carbon unit and stops rescanning a capped sender", (context) => {
    const workspace = createWorkspace(context);
    const sentRefs = [];
    for (let index = 0; index < LIMITS.ownerQueuePerSender + 2; index++) sentRefs.push(sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: `Question ${index}` }).message);
    sendMessage(workspace.scopeFor("stranger"), { to: "@team/sleeper", text: "Other sender" });
    endSession(workspace);
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    const strandedCount = () => workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").get().count;
    assert.equal(strandedCount(), LIMITS.ownerQueuePerSender + 1);
    const lookupStart = workspace.queries.length;
    assert.deepEqual(sweep(workspace), new Set());
    const [lookup] = workspace.queries.slice(lookupStart).filter(({ query }) => query.includes("FROM inbox INDEXED BY inbox_unread_direct"));
    assert.equal(workspace.database.prepare(lookup.query).all(...lookup.bindings).length, 0);
    deleteMessage(workspace.scopeFor("author"), { message: sentRefs[0] });
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    assert.equal(strandedCount(), LIMITS.ownerQueuePerSender + 2);
  });

  test("stranded items omit all context and leave private history inaccessible to siblings", (context) => {
    const workspace = createWorkspace(context);
    sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Private earlier history" });
    endSession(workspace);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Stranded question" });
    const queryStart = workspace.queries.length;
    const item = ownerInboxMessages(workspace.scopeFor("caller"), { limit: 20 }).items[0];
    assert.equal(item.message.id, sent.message);
    assert.equal(item.stranded_from, "@team/sleeper");
    assert.equal(Object.hasOwn(item, "context"), false);
    assert.ok(!workspace.queries.slice(queryStart).some(({ query }) => query.includes("seq < ?")));
    assert.throws(() => markRead(workspace.scopeFor("caller"), { conversation: sent.conversation }), /not found/);
  });

  test("a sibling claim appears in the original recipient inbox without affecting other agents", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Stranded question" });
    workspace.database.prepare("INSERT INTO claims (message_id, agent_id, claimed_at) VALUES (?, 'stranger', ?)").run(workspace.messageIdOf(sent.message), workspace.now);
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].claimed_by, undefined);
    const claimed = sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: sent.message, text: "I will pick this up" });
    assert.equal(claimed.claimed, sent.message);
    assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].claimed_by, "@team/caller");
    sendMessage(workspace.scopeFor("author"), { to: "@team/second", text: "Another question" });
    assert.equal(checkInbox(workspace.scopeFor("second"), {}).items[0].claimed_by, undefined);
    assert.equal(checkInbox(workspace.scopeFor("author"), {}).items[0].claimed_by, undefined);
  });

  test("sweep queues work after the recipient ends and seeks the unread direct index", (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Sent while active" });
    assert.equal(sent.rerouted, undefined);
    endSession(workspace);
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    const queued = workspace.database.prepare("SELECT * FROM owner_messages").get();
    assert.equal(queued.message_id, workspace.messageIdOf(sent.message));
    assert.equal(queued.stranded_from, "sleeper");
    assert.equal(queued.created_at, workspace.now);
    assert.deepEqual(sweep(workspace), new Set());
    const lookups = workspace.queries.filter(({ query }) => query.includes("FROM inbox INDEXED BY inbox_unread_direct"));
    assert.ok(lookups.length);
    for (const lookup of lookups) assert.ok(workspace.explain(lookup).some(step => /SEARCH inbox USING INDEX inbox_unread_direct \(agent_id=\? AND created_at>\?\)/.test(step)), workspace.explain(lookup).join("\n"));
  });

  for (const exclusion of ["read", "old inbox", "revoked", "deleted", "listening", "recent activity", "channel reason", "already queued"]) {
    test(`sweep skips ${exclusion} work`, (context) => {
      const workspace = createWorkspace(context);
      const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Pending question" });
      const messageId = workspace.messageIdOf(sent.message);
      endSession(workspace);
      if (exclusion === "read") markRead(workspace.scopeFor("sleeper"), { messages: [sent.message] });
      if (exclusion === "old inbox") workspace.database.prepare("UPDATE inbox SET created_at = ? WHERE message_id = ?").run(workspace.now - 24 * 60 * 60 * 1000 - 1, messageId);
      if (exclusion === "revoked") workspace.database.prepare("UPDATE agents SET revoked_at = ? WHERE id = 'sleeper'").run(workspace.now);
      if (exclusion === "deleted") deleteMessage(workspace.scopeFor("author"), { message: sent.message });
      if (exclusion === "recent activity") endSession(workspace, "sleeper", workspace.now - LIMITS.agentNameHoldMs + 1);
      if (exclusion === "channel reason") workspace.database.prepare("UPDATE inbox SET reason = 'channel' WHERE message_id = ?").run(messageId);
      if (exclusion === "already queued") workspace.database.prepare("INSERT INTO owner_messages (message_id, owner_sub, created_at) VALUES (?, 'shared', ?)").run(messageId, workspace.now);
      const callback = scopeWithLiveness(workspace, "author", new Set(exclusion === "listening" ? ["sleeper"] : [])).hasSessionEnded;
      assert.deepEqual(sweep(workspace, callback), new Set());
      assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages WHERE stranded_from IS NOT NULL").get().count, 0);
    });
  }

  test("sweep reaches a recipient idle for over 24 hours whose recent DMs are unread", (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Sent while the socket was open" });
    endSession(workspace, "sleeper", workspace.now - 24 * 60 * 60 * 1000 - 1);
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    assert.equal(workspace.database.prepare("SELECT message_id FROM owner_messages").get().message_id, workspace.messageIdOf(sent.message));
  });

  for (const kind of ["private", "group"]) {
    test(`${kind} conversation mentions of an ended member never reroute at send or sweep`, (context) => {
      const workspace = createWorkspace(context);
      addConversation(workspace.database, kind, ["author", "sleeper", "stranger"], kind);
      const sentWhileActive = sendMessage(workspace.scopeFor("author"), { to: `#${kind}`, text: "@team/sleeper earlier secret" });
      assert.equal(checkInbox(workspace.scopeFor("sleeper"), {}).items[0].message.id, sentWhileActive.message);
      endSession(workspace);
      const sentAfterEnd = sendMessage(scopeWithLiveness(workspace), { to: `#${kind}`, text: "@team/sleeper later secret" });
      assert.equal(sentAfterEnd.rerouted, undefined);
      assert.deepEqual(sweep(workspace), new Set());
      assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
    });
  }

  test("the stranded recipient never sees its own copy and answering in the chat claims it for siblings", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Stranded question" });
    const sleeperScope = workspace.scopeFor("sleeper");
    assert.equal(ownerInboxMessages(sleeperScope, { limit: 20 }).items.length, 0);
    assert.equal(countUnreadOwnerMessages(sleeperScope), 0);
    assert.equal(checkInbox(sleeperScope, {}).owner_inbox, undefined);
    assert.equal(newestOwnerMessage(workspace.sql, "shared", workspace.now, "sleeper"), undefined);
    assert.equal(ownerInboxMessages(workspace.scopeFor("caller"), { limit: 20 }).items[0].message.id, sent.message);
    sendMessage(sleeperScope, { to: sent.conversation, text: "Back now, on it" });
    const answeredItem = ownerInboxMessages(workspace.scopeFor("caller"), { limit: 20 }).items[0];
    assert.equal(answeredItem.answered_by_recipient, true);
    assert.equal(answeredItem.claimed_by, undefined);
    assert.throws(() => sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: sent.message, text: "Duplicate pickup" }), /already answered by its recipient @team\/sleeper/);
  });

  test("a stranded recipient answering after a sibling claim keeps the sibling's claim", (context) => {
    const workspace = createWorkspace(context);
    endSession(workspace);
    const sent = sendMessage(scopeWithLiveness(workspace), { to: "@team/sleeper", text: "Stranded question" });
    const claimed = sendMessage(workspace.scopeFor("caller"), { to: "@author/author", reply_to: sent.message, text: "I will pick this up" });
    assert.equal(checkInbox(workspace.scopeFor("author"), {}).items.find((item) => item.message.id === claimed.message).message.text, `Picking up ${sent.message}, which you sent to @team/sleeper after its session ended. Replies continue here.\n\nI will pick this up`);
    sendMessage(workspace.scopeFor("sleeper"), { to: sent.conversation, text: "Back now" });
    assert.deepEqual(workspace.database.prepare("SELECT agent_id FROM claims").all().map(row => row.agent_id), ["caller"]);
    assert.equal(ownerInboxMessages(workspace.scopeFor("second"), { limit: 20 }).items[0].claimed_by, "@team/caller");
  });

  test("sweep includes the exact 24 hour boundary and hides banned authors only at listing", (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Boundary question" });
    const messageId = workspace.messageIdOf(sent.message);
    const earliestTime = workspace.now - 24 * 60 * 60 * 1000;
    endSession(workspace, "sleeper", earliestTime);
    workspace.database.prepare("UPDATE inbox SET created_at = ? WHERE message_id = ?").run(earliestTime, messageId);
    workspace.database.prepare("INSERT INTO bans (kind, subject, owner_sub, label, banned_at, banned_by, reason) VALUES ('agent', 'author', 'author', 'author', ?, 'stranger', 'spam')").run(workspace.now);
    assert.deepEqual(sweep(workspace), new Set(["shared"]));
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox, undefined);
    workspace.database.prepare("DELETE FROM bans").run();
    assert.equal(checkInbox(workspace.scopeFor("caller"), {}).owner_inbox.items[0].message.id, sent.message);
  });

  test("sweep limits the whole batch to 100 messages across recipients and resumes next sweep", (context) => {
    const workspace = createWorkspace(context);
    const senders = Array.from({ length: 20 }, (_, index) => addAgent(workspace.database, `sender-${index}`, { lastActiveAt: workspace.now }));
    for (const recipientId of ["sleeper", "stranger"]) {
      endSession(workspace, recipientId);
      for (const sender of senders) {
        for (let index = 0; index < LIMITS.ownerQueuePerSender; index++) sendMessage(createScope(workspace.sql, sender, workspace.now), { to: `@${workspace.agents[recipientId].handle}`, text: `Question ${index}` });
      }
    }
    assert.deepEqual(sweep(workspace), new Set(["shared", "stranger"]));
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 100);
    assert.deepEqual(sweep(workspace), new Set(["stranger"]));
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 120);
  });

  for (const readyState of [WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]) {
    test(`WorkspaceDO liveness and name holds agree for socket state ${readyState}`, (context) => {
      const workspace = createWorkspace(context);
      endSession(workspace);
      workspace.agents.sleeper.session_hash = "original-session";
      const watchers = attachWatchers(workspace, ["sleeper"]);
      watchers.socketsByAgentId.get("sleeper").readyState = readyState;
      const hasEnded = readyState !== WebSocket.OPEN;
      assert.equal(watchers.durableWorkspace.hasAgentSessionEnded(workspace.agents.sleeper, workspace.now), hasEnded);
      assert.equal(watchers.durableWorkspace.isHeldByAnotherSession(workspace.agents.sleeper, { sessionHash: "new-session" }, workspace.now), !hasEnded);
      const senderScope = watchers.durableWorkspace.scopeFor(workspace.agents.author, "ws_test", workspace.now);
      assert.equal(senderScope.hasSessionEnded(workspace.agents.sleeper), hasEnded);
      const sent = sendMessage(senderScope, { to: "@team/sleeper", text: "Socket question" });
      assert.equal(Boolean(sent.rerouted), hasEnded);
    });
  }

  test("WorkspaceDO persists the once-per-minute sweep gate and pushes after commit", async (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Sent while active" });
    endSession(workspace);
    const watchers = attachWatchers(workspace);
    const durable = watchers.durableWorkspace;
    durable.workspaceDomain = "example.com";
    let currentTime = workspace.now;
    context.mock.method(Date, "now", () => currentTime);
    const first = await durable.tool("check_inbox", callerIdentity(workspace, "caller"), {});
    assert.equal(first.error, undefined);
    assert.equal(watchers.eventsByAgentId.get("caller")[0].message, sent.message);
    assert.equal(workspace.database.prepare("SELECT value FROM meta WHERE key = 'stranded_sweep_at'").get().value, String(currentTime));
    const sweepQueries = () => workspace.queries.filter(({ query }) => query.includes("SELECT id, owner_sub, last_active_at FROM agents")).length;
    assert.equal(sweepQueries(), 1);
    const second = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Queued next minute" });
    currentTime += 59_999;
    assert.equal((await durable.tool("check_inbox", callerIdentity(workspace, "caller"), {})).error, undefined);
    assert.equal(sweepQueries(), 1);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 1);
    currentTime++;
    assert.equal((await durable.tool("check_inbox", callerIdentity(workspace, "caller"), {})).error, undefined);
    assert.equal(sweepQueries(), 2);
    assert.equal(watchers.eventsByAgentId.get("caller").at(-1).message, second.message);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 2);
  });

  test("WorkspaceDO rolls back a failed sweep and preserves the successful tool result", async (context) => {
    const workspace = createWorkspace(context);
    const sent = sendMessage(workspace.scopeFor("author"), { to: "@team/sleeper", text: "Pending question" });
    endSession(workspace);
    const watchers = attachWatchers(workspace);
    watchers.durableWorkspace.workspaceDomain = "example.com";
    workspace.database.exec("CREATE TRIGGER reject_stranded BEFORE INSERT ON owner_messages WHEN NEW.stranded_from IS NOT NULL BEGIN SELECT RAISE(ABORT, 'sweep rejected'); END");
    const loggedErrors = [];
    context.mock.method(console, "error", (...entries) => loggedErrors.push(entries));
    const outcome = await watchers.durableWorkspace.tool("check_inbox", callerIdentity(workspace, "caller"), {});
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.output);
    assert.match(loggedErrors[0][0], /post-commit stranded message sweep failed for check_inbox/);
    assert.equal(workspace.database.prepare("SELECT count(*) AS count FROM owner_messages").get().count, 0);
    assert.equal(workspace.database.prepare("SELECT value FROM meta WHERE key = 'stranded_sweep_at'").get(), undefined);
    assert.equal(watchers.eventsByAgentId.get("caller").length, 0);
    workspace.database.exec("DROP TRIGGER reject_stranded");
    assert.equal((await watchers.durableWorkspace.tool("check_inbox", callerIdentity(workspace, "caller"), {})).error, undefined);
    assert.equal(watchers.eventsByAgentId.get("caller")[0].message, sent.message);
  });
});
