import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../src/schema.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".") || !context.parentURL?.endsWith(".ts")) return nextResolve(specifier, context);
    for (const suffix of [".ts", "/index.ts"]) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

export function createDatabase(migrations = MIGRATIONS) {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(migration);
  const queries = [];
  function queryRows(query, bindings) {
    const statement = database.prepare(query);
    if (/\?\d+/.test(query)) {
      return statement.all(Object.fromEntries(bindings.map((value, index) => [String(index + 1), value])));
    }
    return statement.all(...bindings);
  }
  const sql = {
    exec(query, ...bindings) {
      queries.push({ query, bindings });
      const rows = queryRows(query, bindings);
      const rowsWritten = database.prepare("SELECT changes() AS count").get().count;
      return { toArray: () => rows, rowsWritten, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  const explain = ({ query, bindings }) => queryRows(`EXPLAIN QUERY PLAN ${query}`, bindings).map((row) => row.detail);
  return { database, sql, queries, explain };
}

export function addAgent(database, id, { revokedAt = null, lastActiveAt = 10_000_000, owner = id } = {}) {
  return database.prepare(`INSERT INTO agents
    (id, handle, name, description, owner_sub, owner_email, created_at, last_active_at, revoked_at)
    VALUES (?, ?, ?, '', ?, ?, 1, ?, ?) RETURNING *`).get(id, `team/${id}`, id, owner, `${owner}@example.com`, lastActiveAt, revokedAt);
}

export function addConversation(database, slug, members, kind = "public") {
  const conversation = database.prepare(`INSERT INTO conversations (kind, name, slug, created_by, created_at)
    VALUES (?, ?, ?, ?, 1) RETURNING *`).get(kind, slug, slug, members[0]);
  for (const agentId of members) {
    database.prepare("INSERT INTO members VALUES (?, ?, 1)").run(conversation.id, agentId);
  }
  return conversation;
}

export function createScope(sql, agent, now = 10_000_000) {
  return { sql, agent, now, workspaceId: "ws_test", env: {}, indexJobs: [] };
}

export function addAgentRow(sql, { id, handle, description = "", ownerEmail = "ian.m@posthog.com" }) {
  return sql.exec(
    `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, owner_name, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1) RETURNING *`,
    id,
    handle,
    handle.split("/").pop(),
    description,
    `sub-${id}`,
    ownerEmail,
    "Ian M",
  ).toArray()[0];
}

export function scopeFor(sql, agent, env = {}) {
  return { sql, now: Date.now(), agent, workspaceId: "ws_test0000", env, indexJobs: [] };
}
