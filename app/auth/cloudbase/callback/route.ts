import { NextResponse } from "next/server";
import { safeAuthReturnTo } from "../../../../lib/auth/logout";
import { resolveAuthMode } from "../../../../lib/server/auth";
import { serverAuthOptions } from "../../../../lib/server/auth-runtime";

export const dynamic = "force-dynamic";

/**
 * GET /auth/cloudbase/callback
 *
 * CloudBase WeChat OAuth redirect target. With the CloudBase 云托管 gateway
 * "HTTP 身份认证" enabled, the gateway itself performs the WeChat login and
 * verification and injects `x-cloudbase-context` on every verified request.
 * The application never performs its own OAuth `code` exchange, so this
 * endpoint is effectively unused in production — it simply forwards the
 * browser to the protected path so the gateway can complete/verify the
 * session. Kept as a stable, fail-safe landing URL.
 */
export async function GET(request: Request): Promise<Response> {
  const mode = resolveAuthMode(serverAuthOptions().authMode);
  if (mode !== "cloudbase") {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const returnTo = safeAuthReturnTo(
    url.searchParams.get("state") ?? url.searchParams.get("return_to"),
    "/ledger",
  );

  return NextResponse.redirect(new URL(returnTo, request.url));
}
