import { handleLogout } from "../../../lib/auth/logout";
import { serverAuthOptions } from "../../../lib/server/auth-runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleLogout(request, serverAuthOptions());
}
