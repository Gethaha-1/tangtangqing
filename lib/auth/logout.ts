import {
  AuthenticationError,
  isLoopbackHostname,
  resolveAuthMode,
  resolveNodeEnv,
} from "../server/auth.ts";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
} from "../server/http-security.ts";

export const AUTH_LOGOUT_PATH = "/auth/logout";
export const LOCAL_AUTH_COOKIE = "ttq_local_auth";

const APP_ORIGIN = "https://app.local";
const RESERVED_AUTH_PATHS = new Set([
  AUTH_LOGOUT_PATH,
  "/api/local-auth/signin",
  "/auth/supabase/signin",
]);

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
};

/**
 * POST-only local-development boundary. Production Supabase logout is handled
 * by handleSupabaseAction in the route before this function is called.
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
    throw new AuthenticationError(
      "auth_mode_unavailable",
      "此退出处理器只用于本地测试认证",
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
