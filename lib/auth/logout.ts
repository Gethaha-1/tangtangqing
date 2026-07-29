export const AUTH_LOGOUT_PATH = "/auth/logout";
export const LOCAL_AUTH_COOKIE = "ttq_local_auth";

const APP_ORIGIN = "https://app.local";
const CHATGPT_SIGN_OUT_PATH = "/signout-with-chatgpt";
const RESERVED_AUTH_PATHS = new Set([
  AUTH_LOGOUT_PATH,
  "/callback",
  "/signin-with-chatgpt",
  CHATGPT_SIGN_OUT_PATH,
]);

export type LogoutProvider = {
  readonly id: string;
  signOutLocation(returnTo: string): string;
};

/**
 * Current hosted auth adapter. Sites owns this destination; the application
 * must never implement the dispatcher route itself.
 */
export const chatGPTLogoutProvider: LogoutProvider = {
  id: "chatgpt",
  signOutLocation(returnTo) {
    return `${CHATGPT_SIGN_OUT_PATH}?return_to=${encodeURIComponent(returnTo)}`;
  },
};

/**
 * Stable application-owned URL for all auth UI. A future provider migration
 * only needs to replace the server-side adapter behind this route.
 */
export function authLogoutPath(returnTo = "/"): string {
  return `${AUTH_LOGOUT_PATH}?return_to=${encodeURIComponent(
    safeAuthReturnTo(returnTo),
  )}`;
}

/**
 * Accepts only a same-origin root-relative path. Auth endpoints are rejected
 * to prevent logout/sign-in redirect loops.
 */
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
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

export function clearLocalAuthCookie(): string {
  return `${LOCAL_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Handles the application-owned logout boundary.
 *
 * Hosted traffic delegates session destruction to the Sites dispatcher.
 * Local development has no dispatcher, so it clears only the local HttpOnly
 * test cookie and returns directly to the validated path.
 */
export function handleLogout(
  request: Request,
  provider: LogoutProvider = chatGPTLogoutProvider,
): Response {
  const url = new URL(request.url);
  const returnTo = safeAuthReturnTo(url.searchParams.get("return_to"));
  const local = isLocalAuthHost(url.hostname);
  const headers = new Headers({
    "cache-control": "no-store",
    location: local ? returnTo : provider.signOutLocation(returnTo),
  });

  if (local) headers.set("set-cookie", clearLocalAuthCookie());
  return new Response(null, { status: 302, headers });
}

function isReservedAuthPath(pathname: string): boolean {
  const normalized = pathname.length > 1
    ? pathname.replace(/\/+$/u, "")
    : pathname;
  return RESERVED_AUTH_PATHS.has(normalized);
}
