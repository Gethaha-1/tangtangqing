import { NextResponse } from "next/server";
import {
  setCloudbaseAuthCookie,
} from "../../../../lib/server/cloudbase-auth";
import { safeAuthReturnTo } from "../../../../lib/auth/logout";
import { resolveAuthMode } from "../../../../lib/server/auth";
import { serverAuthOptions } from "../../../../lib/server/auth-runtime";

export const dynamic = "force-dynamic";

/**
 * GET /auth/cloudbase/login
 *
 * Simulate mode (`TTQ_CLOUDBASE_SIMULATE=1`): issues a `sim:<uid>:<name>`
 * session cookie and redirects to return_to (default /ledger). This lets the
 * whole stack run end-to-end without a live CloudBase environment.
 *
 * Production: the CloudBase 云托管 gateway performs the WeChat login and
 * verification itself (HTTP 身份认证). Navigating the browser to the protected
 * path is enough to trigger the gateway's login redirect; after success it
 * injects `x-cloudbase-context` and returns here, so we simply forward to
 * return_to. No custom OAuth exchange is needed (or possible) here.
 */
export async function GET(request: Request): Promise<Response> {
  const mode = resolveAuthMode(serverAuthOptions().authMode);
  if (mode !== "cloudbase") {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const returnTo = safeAuthReturnTo(
    url.searchParams.get("return_to"),
    "/ledger",
  );
  const simulate = process.env.TTQ_CLOUDBASE_SIMULATE === "1";

  if (simulate) {
    const uid = (url.searchParams.get("uid") ?? "demo").trim();
    const name = (url.searchParams.get("name") ?? "微信用户").trim();
    if (!uid || !name) {
      return new Response("缺少 uid 或 name", { status: 400 });
    }
    const token = `sim:${uid}:${name}`;
    const response = NextResponse.redirect(new URL(returnTo, request.url));
    response.headers.append(
      "set-cookie",
      setCloudbaseAuthCookie(request, token),
    );
    return response;
  }

  // Production: hand off to the gateway. The browser hitting the protected
  // path will be authenticated by the CloudBase gateway and bounced back here
  // with a verified identity header.
  return NextResponse.redirect(new URL(returnTo, request.url));
}
