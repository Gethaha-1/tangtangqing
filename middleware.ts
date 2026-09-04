import { NextResponse, type NextRequest } from "next/server";
import {
  adaptAuthenticationAtEdge,
  localAuthCookie,
  assertModeMayServeRequest,
  stripIdentityHeaders,
} from "./lib/server/auth-edge";
import {
  INTERNAL_AUTH_HEADERS,
  resolveAuthMode,
  resolveInternalAuthSecret,
} from "./lib/server/auth";
import { safeAuthReturnTo } from "./lib/auth/logout";
import {
  enforceMutationRequest,
  secureJson,
  RequestSecurityError,
  withSecurityHeaders,
} from "./lib/server/http-security";
import { createSupabaseContext, verifiedSupabasePrincipal } from "./lib/server/supabase-auth";
import { serverAuthOptions } from "./lib/server/auth-runtime";

// Replaces the old Cloudflare Worker edge. It mints internal identity headers
// for every matched request, then protects the /ledger surface.
export const config = {
  matcher: ["/", "/ledger", "/ledger/:path*", "/api/:path*", "/auth/:path*"],
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
    if (mode === "supabase") return await supabaseMiddleware(request);
    const localAutoSignIn = process.env.TTQ_LOCAL_AUTO_SIGNIN === "1";
    const adapted = await adaptAuthenticationAtEdge(request, {
      ...options,
      localAutoSignIn,
    });
    if (
      mode === "local" &&
      localAutoSignIn &&
      new URL(request.url).pathname === "/"
    ) {
      return NextResponse.redirect(new URL("/ledger", request.url));
    }
    if (isLedgerPath(new URL(request.url).pathname) && !hasIdentity(adapted)) {
      const next = encodeURIComponent(safeAuthReturnTo("/ledger"));
      return NextResponse.redirect(new URL(`/?next=${next}`, request.url));
    }
    return ledgerOrNext(request, adapted.headers);
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
    assertModeMayServeRequest(request, "local", process.env.NODE_ENV);
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

async function supabaseMiddleware(request: NextRequest): Promise<Response> {
  const headers = new Headers(request.headers);
  stripIdentityHeaders(headers);
  for (const name of Array.from(headers.keys())) {
    if (name.startsWith("x-cloudbase-") || name.startsWith("x-wx-")) headers.delete(name);
  }
  // API/auth handlers verify with Supabase themselves and write refreshed cookies.
  // Do not make a second cross-region Auth request at the edge for each write.
  if (request.nextUrl.pathname.startsWith("/api/") || request.nextUrl.pathname.startsWith("/auth/")) {
    return withSecurityHeaders(NextResponse.next({ request: { headers } }), request);
  }
  const context = createSupabaseContext(request);
  const identity = await verifiedSupabasePrincipal(context);
  headers.set("cookie", context.requestCookies());
  headers.set(INTERNAL_AUTH_HEADERS.mode, "supabase");
  headers.set(INTERNAL_AUTH_HEADERS.proof, resolveInternalAuthSecret());
  if (identity) {
    headers.set(INTERNAL_AUTH_HEADERS.issuer, identity.issuer);
    headers.set(INTERNAL_AUTH_HEADERS.subject, identity.subject);
    headers.set(INTERNAL_AUTH_HEADERS.displayName, encodeURIComponent(identity.displayName));
    headers.set(INTERNAL_AUTH_HEADERS.email, identity.email ?? "-");
    headers.set(INTERNAL_AUTH_HEADERS.loginName, identity.loginName ?? "-");
  }
  const response = isLedgerPath(request.nextUrl.pathname) && !identity
    ? NextResponse.redirect(new URL("/", request.url))
    : ledgerOrNext(request, headers);
  return context.applyCookies(withSecurityHeaders(response, request));
}

function ledgerOrNext(request: NextRequest, headers: Headers): NextResponse {
  if (request.nextUrl.pathname === "/ledger") {
    return NextResponse.rewrite(new URL("/ledger/index.html", request.url), { request: { headers } });
  }
  return NextResponse.next({ request: { headers } });
}
