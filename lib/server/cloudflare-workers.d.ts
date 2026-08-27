/**
 * D1-compatible type declarations.
 *
 * Originally derived from Cloudflare Workers types, now kept as ambient globals
 * so the data-access layer can compile against `D1Database` without the
 * Cloudflare runtime. The runtime implementation lives in `db/index.ts` (a
 * node:sqlite-backed compat layer).
 */
interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta: {
    changes?: number;
    [key: string]: unknown;
  };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}
