import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS } from "../src/schema.ts";

const { freeSessionName } = await import("../src/store.ts");

function workspaceWith(testContext, agents) {
  const database = new DatabaseSync(":memory:");
  testContext.after(() => database.close());
  for (const migration of MIGRATIONS) database.exec(migration);
  for (const [handle, ownerSub, held] of agents) {
    database.prepare(
      `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at)
       VALUES (?, ?, ?, '', ?, 'owner@example.com', 1, ?)`,
    ).run(handle, handle, handle.split("/")[1], ownerSub, held ? 1 : 0);
  }
  const sql = { exec: (query, ...bindings) => ({ toArray: () => database.prepare(query).all(...bindings) }) };
  const isFree = (agent) => agent.last_active_at === 0;
  return { sql, isFree };
}

test("suggests the base name plus the lowest free number", (testContext) => {
  const { sql, isFree } = workspaceWith(testContext, [["ian/dev", "ian", true]]);
  assert.equal(freeSessionName(sql, "ian/dev", "ian", isFree), "dev-2");
});

test("never stacks suffixes on a numbered name", (testContext) => {
  const { sql, isFree } = workspaceWith(testContext, [["ian/dev", "ian", true], ["ian/dev-2", "ian", true]]);
  assert.equal(freeSessionName(sql, "ian/dev-2", "ian", isFree), "dev-3");
});

test("offers the base name back when its session went quiet", (testContext) => {
  const { sql, isFree } = workspaceWith(testContext, [["ian/dev", "ian", false], ["ian/dev-2", "ian", true]]);
  assert.equal(freeSessionName(sql, "ian/dev-2", "ian", isFree), "dev");
});

test("reuses a quiet numbered agent of the same owner and skips one owned by someone else", (testContext) => {
  const { sql, isFree } = workspaceWith(testContext, [["ian/dev", "ian", true], ["ian/dev-2", "other", false], ["ian/dev-3", "ian", false]]);
  assert.equal(freeSessionName(sql, "ian/dev", "ian", isFree), "dev-3");
});
