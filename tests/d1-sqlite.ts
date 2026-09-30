/**
 * Test double: a D1-compatible wrapper around Node's built-in SQLite, so the
 * real schema and real SQL run in tests. (Node ≥ 22.5)
 */
import { readFileSync } from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite");
import type { D1Database, D1PreparedStatement, D1Result, KVNamespace } from "../src/lib/env";

export function createTestD1(migrationPath: string): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(migrationPath, "utf8"));

  const clean = (vals: unknown[]) => vals.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

  const makeStmt = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values: unknown[]) => makeStmt(sql, values),
    async first<T>() {
      return (db.prepare(sql).get(...clean(params)) ?? null) as T | null;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...clean(params)) as T[], success: true, meta: { changes: 0 } } as D1Result<T>;
    },
    async run() {
      const r = db.prepare(sql).run(...clean(params));
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const out: D1Result[] = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export function createTestKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: "json") {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
  } as KVNamespace & { store: Map<string, string> };
}
