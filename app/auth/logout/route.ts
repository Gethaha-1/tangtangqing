import { handleLogout } from "../../../lib/auth/logout";
import { resolveAuthMode } from "../../../lib/server/auth";
import { handleSupabaseAction } from "../../../lib/server/supabase-actions";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request): Promise<Response> {
  return resolveAuthMode() === "supabase" ? handleSupabaseAction(request, "signout") : handleLogout(request);
}
