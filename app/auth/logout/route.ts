import { handleLogout } from "../../../lib/auth/logout";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return handleLogout(request);
}
