import pg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryResult } from "pg";

const TABLES = new Set([
  "users", "identities", "fleets", "fleet_members", "vehicles",
  "vehicle_assignments", "categories", "fleet_settings", "trips",
  "trip_expenses", "trip_incomes", "maintenance", "sync_commits", "sync_assertions",
  "restore_jobs", "restore_chunks",
]);

function compileControlledSql(
  sql: string,
  parameterToken: (position: number) => string,
): string {
  let output = "";
  let position = 0;
  let parameter = 0;
  while (position < sql.length) {
    const remaining = sql.slice(position);
    if (remaining.startsWith("--")) {
      const end = sql.indexOf("\n", position);
      const stop = end < 0 ? sql.length : end;
      output += sql.slice(position, stop);
      position = stop;
      continue;
    }
    if (remaining.startsWith("/*")) {
      let depth = 1;
      const start = position;
      position += 2;
      while (position < sql.length && depth) {
        if (sql.startsWith("/*", position)) { depth++; position += 2; }
        else if (sql.startsWith("*/", position)) { depth--; position += 2; }
        else position++;
      }
      if (depth) throw new Error("Unterminated SQL comment");
      output += sql.slice(start, position);
      continue;
    }
    const dollar = remaining.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, position + dollar.length);
      if (end < 0) throw new Error("Unterminated SQL literal");
      output += sql.slice(position, end + dollar.length);
      position = end + dollar.length;
      continue;
    }
    const character = sql[position];
    if (character === "'" || character === '"') {
      const start = position++;
      let closed = false;
      while (position < sql.length) {
        if (sql[position++] === character) {
          if (sql[position] === character) position++;
          else { closed = true; break; }
        }
      }
      if (!closed) throw new Error("Unterminated SQL quote");
      output += sql.slice(start, position);
      continue;
    }
    if (character === "?") {
      output += parameterToken(++parameter);
      position++;
      continue;
    }
    const token = remaining.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
    if (token) {
      const name = token.toLowerCase();
      const qualify = (TABLES.has(name) || name === "datetime") && sql[position - 1] !== ".";
      output += qualify ? `ttq.${token}` : token;
      position += token.length;
      continue;
    }
    output += character;
    position++;
  }
  return output;
}

/** Compile the repository's controlled SQL, respecting literals and comments. */
export function compilePostgresSql(sql: string): string {
  return compileControlledSql(sql, (position) => `$${position}`);
}

function postgresLiteral(client: PoolClient, value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return client.escapeLiteral(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value instanceof Uint8Array) {
    return `${client.escapeLiteral(`\\x${Buffer.from(value).toString("hex")}`)}::bytea`;
  }
  if (value instanceof ArrayBuffer) {
    return `${client.escapeLiteral(`\\x${Buffer.from(value).toString("hex")}`)}::bytea`;
  }
  throw new TypeError("只读批次包含不支持的参数类型");
}

function compilePostgresLiteralSql(
  client: PoolClient,
  sql: string,
  values: unknown[],
): string {
  let used = 0;
  const compiled = compileControlledSql(sql, () => {
    if (used >= values.length) throw new Error("SQL 参数数量不足");
    return postgresLiteral(client, values[used++]);
  });
  if (used !== values.length) throw new Error("SQL 参数数量不匹配");
  return compiled.trim().replace(/;+$/, "");
}

export function postgresPoolOptions(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const value = env.TTQ_DATABASE_URL;
  if (!value) throw new Error("TTQ_DATABASE_URL 必须配置为当前 Supabase 项目的后端连接串");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("TTQ_DATABASE_URL 格式无效（连接串已隐藏）"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("数据库连接串协议无效");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (local && env.NETLIFY === "true") throw new Error("Netlify 不能使用本地数据库");
  if (env.TTQ_AUTH_MODE === "supabase" && !local) {
    let authHost: string;
    try { authHost = new URL(env.TTQ_SUPABASE_URL ?? "").hostname; }
    catch { throw new Error("Supabase 项目配置无效"); }
    const ref = authHost.match(/^([a-z0-9]{16,32})\.supabase\.co$/)?.[1];
    const pooler = url.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(url.username) === `ttq_app.${ref}`;
    const direct = url.hostname === `db.${ref}.supabase.co` && decodeURIComponent(url.username) === "ttq_app";
    if (!ref || (!pooler && !direct)) throw new Error("数据库与 Supabase Auth 项目不一致，拒绝连接");
  }
  // node-postgres parses SSL URL parameters after Pool options. Remove them so
  // sslmode=disable/require can never silently override certificate validation.
  url.search = ""; // URL parameters may override ssl/host/options; PoolConfig is authoritative.
  return {
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ...(env.TTQ_DATABASE_CA ? { ca: env.TTQ_DATABASE_CA.replaceAll("\\n", "\n") } : {}) },
    max: 3,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    allowExitOnIdle: true,
    application_name: "tangtangqing-netlify",
    // Monetary cents can exceed int4. Preserve the old safe JS-number contract.
    types: { getTypeParser(oid: number, format?: string) {
      if (oid === 20 && format !== "binary") return (value: string) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error("数据库整数超出安全范围");
        return number;
      };
      return pg.types.getTypeParser(oid, format as "text");
    } },
  };
}

function result<T>(query: QueryResult): D1Result<T> {
  return { results: query.rows as T[], success: true, meta: { changes: query.rowCount ?? 0 } };
}

class PostgresStatement implements D1PreparedStatement {
  readonly owner: PostgresDatabase;
  readonly sql: string;
  readonly values: unknown[];
  constructor(owner: PostgresDatabase, sql: string, values: unknown[] = []) {
    this.owner = owner; this.sql = sql; this.values = values;
  }
  bind(...values: unknown[]): D1PreparedStatement { return new PostgresStatement(this.owner, this.sql, values); }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return result<T>(await this.owner.pool.query(compilePostgresSql(this.sql), this.values));
  }
  run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.all<T>(); }
  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const first = (await this.all<Record<string, unknown>>()).results?.[0];
    return first ? (columnName ? first[columnName] : first) as T : null;
  }
}

/** No named prepared statements: compatible with Supavisor transaction pooling. */
export class PostgresDatabase implements D1Database {
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  prepare(sql: string): D1PreparedStatement { return new PostgresStatement(this, sql); }
  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const client: PoolClient = await this.pool.connect();
    try {
      const owned = statements.map((statement) => {
        if (!(statement instanceof PostgresStatement) || statement.owner !== this) throw new Error("混用数据库语句");
        return statement;
      });
      if (!owned.length) return [];
      const readOnly = owned.every((statement) => /^\s*SELECT\b/i.test(statement.sql));
      // Keep the repository batch atomic while avoiding one trans-oceanic network round
      // trip per statement. All SQL and values originate from this repository;
      // values are escaped by node-postgres before using the simple protocol.
      const sql = [
        `BEGIN ISOLATION LEVEL SERIALIZABLE${readOnly ? " READ ONLY" : ""}`,
        ...owned.map((statement) =>
          compilePostgresLiteralSql(client, statement.sql, statement.values),
        ),
        "COMMIT",
      ].join(";\n");
      const response = await client.query(sql);
      const queries = (Array.isArray(response) ? response : [response]).filter(
        (query) => query.command !== "BEGIN" && query.command !== "COMMIT",
      );
      if (queries.length !== owned.length) throw new Error("数据库批次结果数量不匹配");
      return queries.map((query) => result<T>(query));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (error as { code?: string }).code;
      if (code === "40001" || code === "40P01") {
        // Existing atomic API maps this named guard failure to HTTP 409 and
        // preserves the exact operationId for safe retry. Never auto-replay UI writes.
        throw new Error("sync_assertions_ok_check: concurrent transaction", { cause: error });
      }
      throw error;
    } finally { client.release(); }
  }
}

let database: PostgresDatabase | undefined;
export function getPostgresDatabase(): PostgresDatabase {
  if (!database) {
    const pool = new pg.Pool(postgresPoolOptions());
    pool.on("error", () => console.error("postgres idle connection error"));
    database = new PostgresDatabase(pool);
  }
  return database;
}

export async function assertPostgresSchema(): Promise<void> {
  const { rows } = await getPostgresDatabase().pool.query(
    "SELECT version, current_user AS role FROM ttq.schema_versions WHERE version IN (1, 2)",
  );
  if (rows.length !== 2 || rows.some(row => row.role !== "ttq_app")) {
    throw new Error("请先验证并应用 ledger_recovery 增量迁移，使用 ttq_app 最小权限连接；不能重跑初始化脚本");
  }
}
