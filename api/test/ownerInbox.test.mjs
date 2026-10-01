import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { addAgent, addConversation, createDatabase, createScope } from "./lib/sqlite.mjs";
import { LIMITS } from "../src/limits.ts";
import { MIGRATIONS } from "../src/schema.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "cloudflare:workers") return nextResolve(specifier, context);
    return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
  },
});

const { checkInbox, markRead } = await import("../src/inbox.ts");
const { openChat } = await import("../src/conversations.ts");
const { deleteMessage, sendMessage } = await import("../src/messages.ts");
const { newestOwnerMessage, ownerInboxMessages } = await import("../src/ownerInbox.ts");
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
  durableWorkspace.ctx = {
    storage: {
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
  const { database } = createDatabase(MIGRATIONS.slice(0, -1));
  context.after(() => database.close());
  addAgent(database, "existing");
  database.exec(MIGRATIONS.at(-1));
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

  test("deleting a queued message does not free a cap slot", (context) => {
    const workspace = createWorkspace(context);
    const [firstQueued] = fillSenderCap(workspace, "author");
    deleteMessage(workspace.scopeFor("author"), { message: firstQueued.message });
    assert.equal(sendToOwner(workspace, "author", "After a delete").queued_for, undefined);
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
    const pendingDeliveries = [];
    let notifyBothDeliveries;
    const bothDeliveriesPending = new Promise(resolve => { notifyBothDeliveries = resolve; });
    durable.env.INDEX_QUEUE = {
      sendBatch() {
        return new Promise(resolve => {
          pendingDeliveries.push(resolve);
          if (pendingDeliveries.length === 2) notifyBothDeliveries();
        });
      },
    };
    const sends = ["author", "stranger"].map(agentId => durable.tool("send_message", callerIdentity(workspace, agentId), { to: "@team", text: "Question" }));
    await bothDeliveriesPending;
    for (const finishDelivery of pendingDeliveries) finishDelivery();
    const postedMessages = await Promise.all(sends);
    assert.ok(postedMessages.every(posted => !posted.error));
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
