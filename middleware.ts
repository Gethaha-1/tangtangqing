import { NextResponse, type NextRequest } from "next/server";
import {
  adaptAuthenticationAtEdge,
  localAuthCookie,
} from "./lib/server/auth-edge";
import {
  INTERNAL_AUTH_HEADERS,
  resolveAuthMode,
} from "./lib/server/auth";
import { safeAuthReturnTo } from "./lib/auth/logout";
import {
  enforceMutationRequest,
  secureJson,
  RequestSecurityError,
} from "./lib/server/http-security";
import { serverAuthOptions } from "./lib/server/auth-runtime";

// Replaces the old Cloudflare Worker edge. It mints internal identity headers
// for every matched request, then protects the /ledger surface.
export const config = {
  matcher: ["/ledger", "/ledger/:path*", "/api/:path*"],
};

function hasIdentity(request: Request): boolean {
  return Boolean(request.headers.get(INTERNAL_AUTH_HEADERS.subject));
}

function isLedgerPath(pathname: string): boolean {
  return pathname === "/ledger" || pathname.startsWith("/ledger/");
}

export async function middleware(request: NextRequest) {
  const options = serverAuthOptions();
  const mode = resolveAuthMode(options.authMode);

  // Local sign-in is fully handled at the edge, mirroring the previous worker.
  if (
    mode === "local" &&
    request.method === "POST" &&
    new URL(request.url).pathname === "/api/local-auth/signin"
  ) {
    return handleLocalSignin(request);
  }

  try {
    const adapted = await adaptAuthenticationAtEdge(request, options);
    if (isLedgerPath(new URL(request.url).pathname) && !hasIdentity(adapted)) {
      const next = encodeURIComponent(safeAuthReturnTo("/ledger"));
      return NextResponse.redirect(new URL(`/?next=${next}`, request.url));
    }
    return NextResponse.next({ request: { headers: adapted.headers } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    return secureJson(
      request,
      { error: { code: "auth_failed", message: "认证校验失败" } },
      401,
    );
  }
}

function handleLocalSignin(request: Request): Response {
  try {
    enforceMutationRequest(request);
    const returnTo = safeAuthReturnTo(
      new URL(request.url).searchParams.get("return_to"),
    );
    const response = secureJson(request, { location: returnTo }, 200);
    const headers = new Headers(response.headers);
    headers.append("set-cookie", localAuthCookie(request));
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    throw error;
  }
}
