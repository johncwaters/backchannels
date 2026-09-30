import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { MIGRATIONS } from "../src/schema.ts";

const BACKFILL_DEFAULT_CHANNELS = MIGRATIONS.findIndex((migration) => migration.includes("'backchannels-feedback'"));

function databaseBefore(index) {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS.slice(0, index)) db.exec(migration);
  return db;
}

function addAgent(db, id, { revoked = false } = {}) {
  db.prepare(
    `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at, revoked_at)
     VALUES (?, ?, ?, '', 'sub', 'ian.m@posthog.com', 1, 1, ?)`,
  ).run(id, `ian.m/${id}`, id, revoked ? 2 : null);
}

function addChannel(db, slug, { kind = "public", archived = false, lastSeq = 0 } = {}) {
  db.prepare(
    `INSERT INTO conversations (kind, name, slug, created_by, created_at, archived_at, last_seq) VALUES (?, ?, ?, 'creator', 1, ?, ?)`,
  ).run(kind, slug, slug, archived ? 2 : null, lastSeq);
  return db.prepare("SELECT id FROM conversations WHERE slug = ?").get(slug).id;
}

const channelsOf = (db, agentId) =>
  db
    .prepare("SELECT c.slug FROM members m JOIN conversations c ON c.id = m.conversation_id WHERE m.agent_id = ? ORDER BY c.slug")
    .all(agentId)
    .map((row) => row.slug);

describe("default channel backfill migration", () => {
  test("joins every live agent to the open default channels, with their messages unread", () => {
    const db = databaseBefore(BACKFILL_DEFAULT_CHANNELS);
    addAgent(db, "creator");
    addAgent(db, "old-agent");
    addAgent(db, "revoked-agent", { revoked: true });
    const announcements = addChannel(db, "announcements", { lastSeq: 2 });
    addChannel(db, "help");
    addChannel(db, "general", { archived: true });
    addChannel(db, "backchannels-feedback", { kind: "private" });
    addChannel(db, "deploys");

    db.exec(MIGRATIONS[BACKFILL_DEFAULT_CHANNELS]);

    assert.deepEqual(channelsOf(db, "old-agent"), ["announcements", "help"]);
    assert.deepEqual(channelsOf(db, "revoked-agent"), []);
    const marker = db.prepare("SELECT last_read_seq FROM read_markers WHERE agent_id = 'old-agent' AND conversation_id = ?").get(announcements);
    assert.equal(marker.last_read_seq, 0);
  });

  test("keeps an existing member's read position", () => {
    const db = databaseBefore(BACKFILL_DEFAULT_CHANNELS);
    addAgent(db, "creator");
    const help = addChannel(db, "help", { lastSeq: 5 });
    db.prepare("INSERT INTO members (conversation_id, agent_id, joined_at) VALUES (?, 'creator', 1)").run(help);
    db.prepare("INSERT INTO read_markers (agent_id, conversation_id, last_read_seq) VALUES ('creator', ?, 5)").run(help);

    db.exec(MIGRATIONS[BACKFILL_DEFAULT_CHANNELS]);

    assert.equal(db.prepare("SELECT last_read_seq FROM read_markers WHERE agent_id = 'creator'").get().last_read_seq, 5);
    assert.equal(db.prepare("SELECT count(*) AS n FROM members").get().n, 1);
  });
});
