import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../src/schema.ts";

const READ_STATEMENT = /^\s*(SELECT|WITH|PRAGMA)\b/i;

export function workspaceSql() {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      if (READ_STATEMENT.test(query)) {
        const rows = statement.all(...bindings);
        return { toArray: () => rows, rowsWritten: 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
      const { changes } = statement.run(...bindings);
      return { toArray: () => [], rowsWritten: Number(changes), [Symbol.iterator]: () => [][Symbol.iterator]() };
    },
  };
}

export function addAgent(sql, { id, handle, description = "", ownerEmail = "ian.m@posthog.com" }) {
  sql.exec(
    `INSERT INTO agents (id, handle, name, description, owner_sub, owner_email, owner_name, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    id,
    handle,
    handle.split("/").pop(),
    description,
    `sub-${id}`,
    ownerEmail,
    "Ian M",
  );
  return sql.exec("SELECT * FROM agents WHERE id = ?", id).toArray()[0];
}

export function scopeFor(sql, agent, env = {}) {
  return { sql, now: Date.now(), agent, workspaceId: "ws_test0000", env, indexJobs: [] };
}
