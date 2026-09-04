import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

/**
 * SQLite engine for local development and compatibility tests only.
 *
 * The original Cloudflare D1 binding is replaced by Node's built-in
 * `node:sqlite` (available since Node 22.13). A thin D1-compatible wrapper
 * keeps the data-access layer (runtime-schema/bootstrap/sync-repository)
 * source-compatible so the strict-online + idempotent-receipt invariants are
 * preserved without a rewrite.
 *
 * Production is required to use Supabase PostgreSQL. Local data defaults to
 * ./data/tangtangqing.db and must never be treated as the online ledger.
 */
const DEFAULT_DB_PATH = process.env.TTQ_SQLITE_PATH ?? "data/tangtangqing.db";

let sqliteDb: DatabaseSync | null = null;

export function getSqlite(): DatabaseSync {
  if (!sqliteDb) {
    mkdirSync(dirname(DEFAULT_DB_PATH), { recursive: true });
    sqliteDb = new DatabaseSync(DEFAULT_DB_PATH);
    sqliteDb.exec("PRAGMA journal_mode = WAL");
    sqliteDb.exec("PRAGMA foreign_keys = ON");
  }
  return sqliteDb;
}

/**
 * Drizzle handle backed by node:sqlite via the proxy driver. The data-access
 * layer uses the D1-compatible `getD1()`; this keeps the typed Drizzle schema
 * available for future use without a native dependency.
 */
export function getDb() {
  return drizzle(
    async     (sql: string, params: unknown[], method: string) => {
      const statement = getSqlite().prepare(sql);
      const bound = params as SQLInputValue[];
      if (method === "run") {
        statement.run(...bound);
        return { rows: [] };
      }
      if (method === "values") {
        const rows = statement.all(...bound) as Record<string, unknown>[];
        return { rows: rows.map((row) => Object.values(row)) };
      }
      if (method === "get") {
        const row = statement.get(...bound) as
          | Record<string, unknown>
          | undefined;
        return { rows: row == null ? [] : [row] };
      }
      const rows = statement.all(...bound) as Record<string, unknown>[];
      return { rows };
    },
    { schema },
  );
}

/** D1-compatible prepared statement over node:sqlite. */
class CompatStatement implements D1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new CompatStatement(this.db, this.sql, values);
  }

  private statement(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.statement().all(
      ...(this.params as SQLInputValue[]),
    ) as T[];
    return { results, success: true, meta: {} };
  }

  async first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null> {
    const row = this.statement().get(
      ...(this.params as SQLInputValue[]),
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (columnName) return (row[columnName] as T) ?? null;
    return row as unknown as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.statement().run(
      ...(this.params as SQLInputValue[]),
    ) as {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    return {
      results: [],
      success: true,
      meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
    };
  }
}

/** D1-compatible database over node:sqlite. */
class CompatDatabase implements D1Database {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new CompatStatement(this.db, query);
  }

  /**
   * D1 batch is atomic. We replicate that with an explicit transaction so a
   * failed CHECK (e.g. a version-guard assertion) rolls back the whole batch,
   * keeping the idempotent-receipt invariant intact.
   */
  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.db.exec("BEGIN");
    try {
      const out: D1Result<T>[] = [];
      for (const statement of statements as CompatStatement[]) {
        out.push(await statement.all<T>());
      }
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

let d1Instance: D1Database | null = null;

/** Drop-in replacement for the old Cloudflare `getD1()`. */
export function getD1(): D1Database {
  if (!d1Instance) {
    d1Instance = new CompatDatabase(getSqlite());
  }
  return d1Instance;
}
