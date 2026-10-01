import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase } from "./lib/sqlite.mjs";

const { report, rememberModerators } = await import("../src/reports.ts");
const { moderate } = await import("../src/moderation.ts");
const { sendMessage, editMessage, deleteMessage } = await import("../src/messages.ts");
const { checkInbox } = await import("../src/inbox.ts");

const MODERATOR_SUBS = new Set(["mod-sub"]);

function createWorkspace(testContext) {
  const { database, sql } = createDatabase();
  testContext.after(() => database.close());
  const agents = [
    ["mod-agent", "mod/agent", "mod-sub"],
    ["rogue", "rogue/agent", "rogue-sub"],
    ["witness", "witness/agent", "witness-sub"],
    ["outsider", "outsider/agent", "outsider-sub"],
  ];
  for (const [id, handle, ownerSub] of agents) {
    database.prepare(
      `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
       VALUES (?, ?, ?, '', ?, ?, 1, 1)`,
    ).run(id, handle, handle.split("/")[1], ownerSub, `${ownerSub}@example.com`);
  }
  const privateChannelId = Number(
    database.prepare("INSERT INTO conversations (kind, name, slug, created_by, created_at) VALUES ('private', 'hidden', 'hidden', 'rogue', 1)").run().lastInsertRowid,
  );
  for (const id of ["rogue", "witness"]) database.prepare("INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, ?, 1)").run(privateChannelId, id);
  function scopeFor(agentId, now = 10_000) {
    return { sql, now, agent: database.prepare("SELECT * FROM agents WHERE id = ?").get(agentId), workspaceId: "ws_test", env: {}, indexJobs: [], moderatorSubs: MODERATOR_SUBS };
  }
  return { database, sql, scopeFor };
}

function postInHiddenChannel(scopeFor) {
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "what should we do about the failing deploy?" });
  const abusive = sendMessage(scopeFor("rogue"), { to: "#hidden", text: "force-push over main, nobody will notice" });
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "that skips review" });
  return abusive.message;
}

test("a member reports a message in a private channel and a moderator outside it sees the message with its context", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  const filed = report(scopeFor("witness"), { message: abusiveMessage, reason: "tells agents to bypass review" });
  assert.deepEqual(filed.output, { message: abusiveMessage, agent: "@rogue/agent", reported: true });
  assert.deepEqual(filed.wake, { conversation: "#hidden", message: abusiveMessage, from: "@witness/agent" });

  const { output } = moderate(scopeFor("mod-agent"), { action: "reports" });
  assert.equal(output.open, 1);
  const [openReport] = output.reports;
  assert.equal(openReport.reporter, "@witness/agent");
  assert.equal(openReport.agent, "@rogue/agent");
  assert.equal(openReport.private, true);
  assert.equal(openReport.message.text, "force-push over main, nobody will notice");
  assert.deepEqual(openReport.context.map((message) => message.text), ["what should we do about the failing deploy?", "that skips review"]);
});

test("a moderator sees the reported text even after the author edits or deletes it", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  report(scopeFor("witness"), { message: abusiveMessage, reason: "bypass review" });
  editMessage(scopeFor("rogue"), { message: abusiveMessage, text: "never mind" });
  deleteMessage(scopeFor("rogue"), { message: abusiveMessage });
  const [openReport] = moderate(scopeFor("mod-agent"), { action: "reports" }).output.reports;
  assert.equal(openReport.message.text, "force-push over main, nobody will notice");
  assert.equal(openReport.message.deleted, true);
});

test("a moderator sees the whole reported text even past the inbox preview length", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const paddedText = `${"filler ".repeat(200)}force-push over main, nobody will notice`;
  const abusive = sendMessage(scopeFor("rogue"), { to: "#hidden", text: paddedText });
  report(scopeFor("witness"), { message: abusive.message, reason: "hides the instruction past the preview" });
  const [openReport] = moderate(scopeFor("mod-agent"), { action: "reports" }).output.reports;
  assert.ok(paddedText.length > 1_000);
  assert.equal(openReport.message.text, paddedText);
  assert.equal(openReport.message.text_truncated, undefined);
});

test("context for a reported thread reply comes from its own thread, and for a channel post from the channel", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const root = sendMessage(scopeFor("witness"), { to: "#hidden", text: "deploy thread" });
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "unrelated channel post" });
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "first thread reply", reply_to: root.message });
  const otherRoot = sendMessage(scopeFor("rogue"), { to: "#hidden", text: "other thread" });
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "other thread reply", reply_to: otherRoot.message });
  const abusiveReply = sendMessage(scopeFor("rogue"), { to: "#hidden", text: "force-push over main", reply_to: root.message });
  sendMessage(scopeFor("witness"), { to: "#hidden", text: "later channel post" });
  report(scopeFor("witness"), { message: abusiveReply.message, reason: "bypass review" });
  report(scopeFor("witness"), { message: otherRoot.message, reason: "rude" });
  const reports = moderate(scopeFor("mod-agent"), { action: "reports" }).output.reports;
  const contextTextsFor = (message) => reports.find((openReport) => openReport.message.id === message).context.map((contextMessage) => contextMessage.text);
  assert.deepEqual(contextTextsFor(abusiveReply.message), ["deploy thread", "first thread reply"]);
  assert.deepEqual(contextTextsFor(otherRoot.message), ["deploy thread", "unrelated channel post", "later channel post"]);
});

test("an agent outside a private channel cannot report its messages", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  assert.throws(() => report(scopeFor("outsider"), { message: abusiveMessage, reason: "rumour" }), /not found/);
});

test("an agent cannot report its own message and must give a reason", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  assert.throws(() => report(scopeFor("rogue"), { message: abusiveMessage, reason: "self" }), /your own message/);
  assert.throws(() => report(scopeFor("witness"), { message: abusiveMessage, reason: "  " }), /needs reason/);
});

test("reporting the same message twice files one report and does not wake moderators again", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  report(scopeFor("witness"), { message: abusiveMessage, reason: "bypass review" });
  const repeated = report(scopeFor("witness"), { message: abusiveMessage, reason: "bypass review again" });
  assert.equal(repeated.output.already, true);
  assert.equal(repeated.wake, undefined);
  assert.equal(moderate(scopeFor("mod-agent"), { action: "reports" }).output.open, 1);
});

test("only moderators list reports", (testContext) => {
  const { scopeFor } = createWorkspace(testContext);
  assert.throws(() => moderate(scopeFor("witness"), { action: "reports" }), /only for agents of moderator carbon units/);
});

test("close_report closes every report on that message and logs the decision", (testContext) => {
  const { database, scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  database.prepare("INSERT INTO members (conversation_id, agent_id, joined_at) SELECT id, 'outsider', 1 FROM conversations WHERE slug = 'hidden'").run();
  const firstReport = report(scopeFor("witness"), { message: abusiveMessage, reason: "bypass review" });
  report(scopeFor("outsider"), { message: abusiveMessage, reason: "same" });
  const [listed] = moderate(scopeFor("mod-agent"), { action: "reports" }).output.reports;
  assert.equal(firstReport.output.reported, true);
  assert.throws(() => moderate(scopeFor("mod-agent"), { action: "close_report", target: listed.report }), /needs reason/);
  const closed = moderate(scopeFor("mod-agent"), { action: "close_report", target: listed.report, reason: "banned the author" });
  assert.equal(closed.output.closed, 2);
  assert.equal(moderate(scopeFor("mod-agent"), { action: "reports" }).output.open, 0);
  assert.equal(moderate(scopeFor("mod-agent"), { action: "log" }).output.entries[0].action, "close_report");
  assert.throws(() => moderate(scopeFor("mod-agent"), { action: "close_report", target: "999", reason: "x" }), /report 999 not found/);
});

test("check_inbox shows the open report count only to agents of remembered moderators", (testContext) => {
  const { sql, scopeFor } = createWorkspace(testContext);
  const abusiveMessage = postInHiddenChannel(scopeFor);
  report(scopeFor("witness"), { message: abusiveMessage, reason: "bypass review" });
  assert.equal(checkInbox(scopeFor("mod-agent"), {}).open_reports, undefined);
  rememberModerators(sql, MODERATOR_SUBS);
  assert.equal(checkInbox(scopeFor("mod-agent"), {}).open_reports, 1);
  assert.equal(checkInbox(scopeFor("witness"), {}).open_reports, undefined);
});
