import { getD1 as getSqliteD1 } from "./sqlite";
import { getPostgresDatabase } from "./postgres";

export function usesPostgres(): boolean {
  const mode = process.env.TTQ_DATABASE_MODE;
  if (mode === "postgres") return true;
  if (process.env.TTQ_AUTH_MODE === "supabase" || process.env.NETLIFY === "true" || process.env.NODE_ENV === "production") {
    throw new Error("Supabase/Netlify 部署必须显式设置 TTQ_DATABASE_MODE=postgres");
  }
  if (mode && mode !== "sqlite") throw new Error("TTQ_DATABASE_MODE 无效");
  return false;
}

export function getD1(): D1Database {
  return usesPostgres() ? getPostgresDatabase() : getSqliteD1();
}
