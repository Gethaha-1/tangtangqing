import { handleSupabaseAction } from "../../../../lib/server/supabase-actions";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request): Promise<Response> {
  return handleSupabaseAction(request, "signin");
}
