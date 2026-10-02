import assert from "node:assert/strict";
import { test } from "node:test";
import { findViewer, isWorkspaceAdmin, isWorkspaceModerator, workspaceAdminSubs, workspaceModeratorSubs } from "../src/directory.ts";
import { createD1 } from "./lib/d1.mjs";

const WORKSPACE = "ws_roles";
const OTHER_WORKSPACE = "ws_other";

function addCarbonUnit(database, sub, workspaceId, extra = {}) {
  const columns = ["sub", "workspace_id", "email", "created_at", "last_seen_at", ...Object.keys(extra)];
  const values = [sub, workspaceId, `${sub}@example.com`, 1, 1, ...Object.values(extra)];
  database.prepare(`INSERT INTO carbon_units (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

function workspaces(database) {
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) database.prepare("INSERT INTO workspaces (id, domain, name, created_at) VALUES (?, ?, ?, 1)").run(id, `${id}.example`, id);
}

test("the roles migration turns every existing moderator into a moderator and everyone else into a member", () => {
  const { database, applyMigration } = createD1({ throughMigration: 5 });
  workspaces(database);
  addCarbonUnit(database, "flagged", WORKSPACE, { is_admin: 1 });
  addCarbonUnit(database, "plain", WORKSPACE, { is_admin: 0 });
  applyMigration(6);
  const roles = Object.fromEntries(database.prepare("SELECT sub, role FROM carbon_units").all().map((row) => [row.sub, row.role]));
  assert.deepEqual(roles, { flagged: "moderator", plain: "member" });
});

test("the role column refuses values outside admin, moderator and member", () => {
  const { database } = createD1();
  workspaces(database);
  assert.throws(() => addCarbonUnit(database, "owner", WORKSPACE, { role: "owner" }), /CHECK constraint/);
});

test("admins also moderate; moderators do not administer; members do neither", async () => {
  const { database, db } = createD1();
  workspaces(database);
  addCarbonUnit(database, "admin", WORKSPACE, { role: "admin" });
  addCarbonUnit(database, "moderator", WORKSPACE, { role: "moderator" });
  addCarbonUnit(database, "member", WORKSPACE);
  addCarbonUnit(database, "elsewhere", OTHER_WORKSPACE, { role: "admin" });
  const can = async (sub) => [await isWorkspaceAdmin(db, sub, WORKSPACE), await isWorkspaceModerator(db, sub, WORKSPACE)];
  assert.deepEqual(await can("admin"), [true, true]);
  assert.deepEqual(await can("moderator"), [false, true]);
  assert.deepEqual(await can("member"), [false, false]);
  assert.deepEqual(await can("elsewhere"), [false, false]);
  assert.deepEqual((await workspaceModeratorSubs(db, WORKSPACE)).sort(), ["admin", "moderator"]);
  assert.deepEqual(await workspaceAdminSubs(db, WORKSPACE), ["admin"]);
  assert.equal((await findViewer(db, "moderator", WORKSPACE)).role, "moderator");
});
