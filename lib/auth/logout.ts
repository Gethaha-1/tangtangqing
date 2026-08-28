import {
  AuthenticationError,
  isLoopbackHostname,
  resolveAuthMode,
  resolveNodeEnv,
  type AuthMode,
} from "../server/auth.ts";
import {
  clearCloudbaseAuthCookie,
} from "../server/cloudbase-auth.ts";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
} from "../server/http-security.ts";

export const AUTH_LOGOUT_PATH = "/auth/logout";
export const LOCAL_AUTH_COOKIE = "ttq_local_auth";

const APP_ORIGIN = "https://app.local";
const SITES_SIGN_OUT_PATH = "/signout-with-chatgpt";
const RESERVED_AUTH_PATHS = new Set([
  AUTH_LOGOUT_PATH,
  "/callback",
  "/signin-with-chatgpt",
  SITES_SIGN_OUT_PATH,
  "/api/local-auth/signin",
  "/auth/supabase/signin",
  "/auth/cloudbase/login",
  "/auth/cloudbase/callback",
]);

export type LogoutProvider = {
  readonly id: AuthMode;
  signOutLocation(returnTo: string): string;
};

export const sitesLogoutProvider: LogoutProvider = {
  id: "sites",
  signOutLocation(returnTo) {
    return `${SITES_SIGN_OUT_PATH}?return_to=${encodeURIComponent(returnTo)}`;
  },
};

// Compatibility export for existing UI imports; provider selection itself is
// now based on TTQ_AUTH_MODE rather than this name.
export const chatGPTLogoutProvider = sitesLogoutProvider;

export function authLogoutPath(returnTo = "/"): string {
  return `${AUTH_LOGOUT_PATH}?return_to=${encodeURIComponent(
    safeAuthReturnTo(returnTo),
  )}`;
}

export function safeAuthReturnTo(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)
  ) {
    return fallback;
  }

  try {
    const url = new URL(value, APP_ORIGIN);
    const decodedPathname = decodeURIComponent(url.pathname);
    if (
      url.origin !== APP_ORIGIN ||
      url.username ||
      url.password ||
      decodedPathname.startsWith("//") ||
      decodedPathname.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(decodedPathname) ||
      isReservedAuthPath(url.pathname) ||
      isReservedAuthPath(decodedPathname)
    ) {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function isLocalAuthHost(hostname: string): boolean {
  return isLoopbackHostname(hostname);
}

export function clearLocalAuthCookie(request?: Request): string {
  const secure = request && new URL(request.url).protocol === "https:";
  return [
    `${LOCAL_AUTH_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

export type LogoutOptions = {
  authMode?: string | null;
  nodeEnv?: string | null;
  sitesProvider?: LogoutProvider;
};

/**
 * POST-only application boundary. It returns a sanitized navigation target;
 * the client deliberately performs any provider-owned GET navigation after
 * this same-origin request succeeds.
 */
export async function handleLogout(
  request: Request,
  options: LogoutOptions = {},
): Promise<Response> {
  try {
    enforceMutationRequest(request);
    await readJsonWithinLimit(request);
    const mode = resolveAuthMode(options.authMode);
    const url = new URL(request.url);
    const returnTo = safeAuthReturnTo(url.searchParams.get("return_to"));

    if (mode === "cloudbase") {
      // Clear the local session cookie we issued (our ttq_cb_token), then let
      // the client navigate to returnTo. In production with CloudBase gateway
      // auth you may also redirect to the CloudBase sign-out endpoint; for the
      // custom-token path clearing our cookie is sufficient and fail-safe.
      const response = secureJson(request, { location: returnTo }, 200);
      const headers = new Headers(response.headers);
      headers.append("set-cookie", clearCloudbaseAuthCookie(request));
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    if (mode === "local") {
      if (
        resolveNodeEnv(options.nodeEnv) !== "development" ||
        !isLocalAuthHost(url.hostname)
      ) {
        throw new AuthenticationError(
          "auth_mode_unavailable",
          "本地测试认证只允许显式 development loopback 环境",
        );
      }
      const response = secureJson(request, { location: returnTo }, 200);
      const headers = new Headers(response.headers);
      headers.append("set-cookie", clearLocalAuthCookie(request));
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    const provider = options.sitesProvider ?? sitesLogoutProvider;
    return secureJson(
      request,
      { location: provider.signOutLocation(returnTo) },
      200,
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    if (error instanceof AuthenticationError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.code === "unauthenticated" ? 401 : 503,
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return secureJson(
        request,
        { error: { code: "invalid_json", message: "请求不是有效 JSON" } },
        400,
      );
    }
    throw error;
  }
}

function isReservedAuthPath(pathname: string): boolean {
  const normalized = pathname.length > 1
    ? pathname.replace(/\/+$/u, "")
    : pathname;
  return RESERVED_AUTH_PATHS.has(normalized);
}
