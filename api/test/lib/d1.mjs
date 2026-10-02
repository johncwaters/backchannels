import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

function statement(database, sql, bindings = []) {
  const prepared = () => database.prepare(sql);
  return {
    bind: (...values) => statement(database, sql, values),
    first: async (column) => {
      const row = prepared().get(...bindings);
      if (!row) return null;
      return column === undefined ? { ...row } : row[column];
    },
    all: async () => ({ results: prepared().all(...bindings).map((row) => ({ ...row })) }),
    run: async () => {
      const result = prepared().run(...bindings);
      return { meta: { changes: Number(result.changes) } };
    },
  };
}

export function createD1({ throughMigration = Infinity } = {}) {
  const database = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIRECTORY).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    if (Number.parseInt(name, 10) > throughMigration) continue;
    database.exec(readFileSync(new URL(name, MIGRATIONS_DIRECTORY), "utf8"));
  }
  return {
    database,
    db: { prepare: (sql) => statement(database, sql) },
    applyMigration(number) {
      const name = files.find((file) => Number.parseInt(file, 10) === number);
      database.exec(readFileSync(new URL(name, MIGRATIONS_DIRECTORY), "utf8"));
    },
  };
}
