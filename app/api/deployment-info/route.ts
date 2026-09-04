import { postgresPoolOptions } from "../../../db/postgres";
import { supabaseConfiguration } from "../../../lib/server/supabase-auth";
import { secureJson } from "../../../lib/server/http-security";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public, non-secret marker so verification can confirm the intended stack and project. */
export function GET(request: Request): Response {
  try {
    if (process.env.TTQ_AUTH_MODE !== "supabase" || process.env.TTQ_DATABASE_MODE !== "postgres") throw new Error("mode");
    const config = supabaseConfiguration();
    postgresPoolOptions(); // also verifies the Auth/database project binding
    const hostname = new URL(config.url).hostname;
    return secureJson(request, {
      deployment: "netlify-supabase",
      supabaseProjectRef: hostname.endsWith(".supabase.co") ? hostname.split(".")[0] : "local-test",
    }, 200);
  } catch {
    return secureJson(request, { deployment: "netlify-supabase", error: "configuration_incomplete" }, 503);
  }
}
