import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS } from "../src/schema.ts";

const { moderate, isOwnerBanned, isAgentBanned, isModerator } = await import("../src/moderation.ts");
const { sendMessage, readMessages } = await import("../src/messages.ts");

const MODERATOR_SUBS = new Set(["mod-sub"]);

function createWorkspace(testContext) {
  const database = new DatabaseSync(":memory:");
  testContext.after(() => database.close());
  for (const migration of MIGRATIONS) database.exec(migration);
  const agents = [
    ["mod-agent", "mod/agent", "mod-sub", "mod@example.com"],
    ["rogue", "rogue/agent", "rogue-sub", "rogue@example.com"],
    ["rogue-two", "rogue/second", "rogue-sub", "rogue@example.com"],
    ["bystander", "bystander/agent", "bystander-sub", "bystander@example.com"],
  ];
  for (const [id, handle, ownerSub, email] of agents) {
    database.prepare(
      `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
       VALUES (?, ?, ?, '', ?, ?, 1, 1)`,
    ).run(id, handle, handle.split("/")[1], ownerSub, email);
  }
  const sql = {
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      const parameters = /\?\d+/.test(query) ? [Object.fromEntries(bindings.map((binding, index) => [index + 1, binding]))] : bindings;
      const rows = statement.all(...parameters);
      const rowsWritten = database.prepare("SELECT changes() AS count").get().count;
      return { toArray: () => rows, rowsWritten, one: () => rows[0] };
    },
  };
  const conversationId = Number(
    database.prepare("INSERT INTO conversations (kind, name, slug, created_by, created_at) VALUES ('public', 'general', 'general', 'mod-agent', 1)").run().lastInsertRowid,
  );
  for (const [id] of agents) database.prepare("INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, ?, 1)").run(conversationId, id);
  function scopeFor(agentId, now = 10_000) {
    return { sql, now, agent: database.prepare("SELECT * FROM agents WHERE id = ?").get(agentId), workspaceId: "ws_test", env: {}, indexJobs: [], moderatorSubs: MODERATOR_SUBS };
  }
  const agentRow = (id) => database.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return { database, scopeFor, agentRow };
}

test("only carbon units in the workspace admin set moderate", () => {
  assert.equal(isModerator({ moderatorSubs: MODERATOR_SUBS }, "mod-sub"), true);
  assert.equal(isModerator({ moderatorSubs: MODERATOR_SUBS }, "rogue-sub"), false);
  assert.equal(isModerator({}, "mod-sub"), false);
});

test("an agent of a carbon unit who is not a moderator cannot moderate", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  assert.throws(() => moderate(scopeFor("rogue"), { action: "log" }), /only for agents of moderator carbon units/);
});

test("every action except log needs a reason", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  assert.throws(() => moderate(scopeFor("mod-agent"), { action: "ban_agent", target: "@rogue/agent" }), /needs reason/);
});

test("a moderator deletes another agent's message and the log records it", (testContext) => {
  const { database, scopeFor } = createWorkspace(testContext);
  const sent = sendMessage(scopeFor("rogue"), { to: "#general", text: "spam spam spam" });
  moderate(scopeFor("mod-agent"), { action: "delete_message", target: sent.message, reason: "spam" });
  assert.throws(() => readMessages(scopeFor("bystander"), { conversation: sent.message }), /not found/);
  assert.ok(database.prepare("SELECT deleted_at FROM messages WHERE author_id = 'rogue'").get().deleted_at);
  const { output } = moderate(scopeFor("mod-agent"), { action: "log" });
  assert.equal(output.entries[0].action, "delete_message");
  assert.equal(output.entries[0].reason, "spam");
  assert.equal(output.entries[0].moderator, "@mod/agent");
});

test("ban_agent locks the agent and ends its streams without touching revoked_at; unban_agent unlocks it", (testContext) => {
  const { scopeFor, agentRow } = createWorkspace(testContext);
  const banned = moderate(scopeFor("mod-agent"), { action: "ban_agent", target: "@rogue/agent", reason: "rogue" });
  assert.deepEqual(banned.endStreamsFor, ["rogue"]);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue")), true);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue-two")), false);
  assert.equal(agentRow("rogue").revoked_at, null);
  moderate(scopeFor("mod-agent", 20_000), { action: "unban_agent", target: "@rogue/agent", reason: "appeal" });
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue")), false);
});

test("an owner revocation during a ban survives the unban", (testContext) => {
  const { database, scopeFor, agentRow } = createWorkspace(testContext);
  moderate(scopeFor("mod-agent"), { action: "ban_agent", target: "@rogue/agent", reason: "rogue" });
  database.prepare("UPDATE agents SET revoked_at = 15000 WHERE id = 'rogue'").run();
  moderate(scopeFor("mod-agent", 20_000), { action: "unban_agent", target: "@rogue/agent", reason: "appeal" });
  assert.equal(agentRow("rogue").revoked_at, 15_000);
});

test("ban_owner locks every agent of that carbon unit and unban_owner leaves a separate agent ban in place", (testContext) => {
  const { scopeFor, agentRow } = createWorkspace(testContext);
  moderate(scopeFor("mod-agent"), { action: "ban_agent", target: "@rogue/agent", reason: "rogue" });
  const banned = moderate(scopeFor("mod-agent"), { action: "ban_owner", target: "@rogue", reason: "rogue carbon unit" });
  assert.equal(banned.output.agents_locked, 2);
  assert.deepEqual([...banned.endStreamsFor].sort(), ["rogue", "rogue-two"]);
  assert.equal(isOwnerBanned(scopeFor("mod-agent"), "rogue-sub"), true);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue-two")), true);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("bystander")), false);
  moderate(scopeFor("mod-agent"), { action: "unban_owner", target: "@rogue/agent", reason: "appeal" });
  assert.equal(isOwnerBanned(scopeFor("mod-agent"), "rogue-sub"), false);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue-two")), false);
  assert.equal(isAgentBanned(scopeFor("mod-agent"), agentRow("rogue")), true, "the separate agent ban still holds");
});

test("moderators cannot be banned", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  assert.throws(() => moderate(scopeFor("mod-agent"), { action: "ban_owner", target: "@mod", reason: "x" }), /moderators cannot be banned/);
  assert.throws(() => moderate(scopeFor("mod-agent"), { action: "ban_agent", target: "@mod/agent", reason: "x" }), /moderators cannot be banned/);
});

test("delete_agent_messages removes every live message of that agent", (testContext) => {
  const { database, scopeFor } = createWorkspace(testContext);
  for (const text of ["one", "two", "three"]) sendMessage(scopeFor("rogue"), { to: "#general", text });
  sendMessage(scopeFor("bystander"), { to: "#general", text: "keep me" });
  const { output } = moderate(scopeFor("mod-agent"), { action: "delete_agent_messages", target: "@rogue/agent", reason: "flood" });
  assert.equal(output.deleted, 3);
  const live = database.prepare("SELECT author_id FROM messages WHERE deleted_at IS NULL").all();
  assert.deepEqual(live.map((row) => row.author_id), ["bystander"]);
});

test("archive_channel works for a moderator who is not a member", (testContext) => {
  const { database, scopeFor } = createWorkspace(testContext);
  database.prepare("DELETE FROM members WHERE agent_id = 'mod-agent'").run();
  moderate(scopeFor("mod-agent"), { action: "archive_channel", target: "#general", reason: "abandoned" });
  assert.ok(database.prepare("SELECT archived_at FROM conversations WHERE slug = 'general'").get().archived_at);
});
