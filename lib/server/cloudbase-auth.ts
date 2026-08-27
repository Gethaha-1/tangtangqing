import {
  AuthenticationError,
  type PrincipalOptions,
} from "./auth.ts";

/**
 * Cookie we set in simulate mode to carry a `sim:<uid>:<name>` marker. In
 * production CloudBase auth this is unused — the gateway manages its own
 * session and injects the identity header on every verified request.
 */
export const CLOUDBASE_TOKEN_COOKIE = "ttq_cb_token";

/**
 * Headers the CloudBase 云托管 gateway injects after a successful identity
 * check (开启 HTTP 身份认证). They are set by the gateway, not by the client,
 * so (unlike our internal headers) we treat them as a trusted upstream
 * assertion. `x-cloudbase-context` is Base64(JSON) and contains `uid`.
 *
 * See https://docs.cloudbase.net/faq/knowledge/cloudrun-authentication-integration
 */
export const CLOUDBASE_GATEWAY_HEADERS = {
  context: "x-cloudbase-context",
  uid: "x-cloudbase-uid",
  openid: "x-wx-openid",
  unionid: "x-wx-unionid",
} as const;

const SIMULATE_PREFIX = "sim:";

export type CloudbaseIdentity = {
  uid: string;
  nickName: string;
  email: string | null;
};

/**
 * Resolves the authenticated CloudBase principal from a request.
 *
 * Two paths:
 *  - Simulate (`TTQ_CLOUDBASE_SIMULATE=1`): accepts `sim:<uid>:<displayName>`
 *    tokens so local/dev/test can run end-to-end without a real CloudBase env.
 *  - Production: trusts the CloudBase gateway-injected `x-cloudbase-context`
 *    header. The gateway (云托管 HTTP 身份认证) completes the WeChat login and
 *    verification server-side, so the app never sees or verifies a raw token
 *    and needs no Node SDK in the Edge runtime. Any request without a valid
 *    gateway context fails closed with `unauthenticated`.
 */
export async function verifyCloudbaseIdentity(
  request: Request,
  options: PrincipalOptions = {},
): Promise<CloudbaseIdentity> {
  // This verifier is only meaningful for the cloudbase auth mode.
  if (options.authMode && options.authMode !== "cloudbase") {
    throw new AuthenticationError(
      "auth_mode_invalid",
      "CloudBase 校验仅适用于 cloudbase 模式",
    );
  }

  const simulate = process.env.TTQ_CLOUDBASE_SIMULATE === "1";

  if (simulate) {
    const token = readCloudbaseToken(request);
    if (token && token.startsWith(SIMULATE_PREFIX)) {
      return parseSimToken(token);
    }
    throw new AuthenticationError("unauthenticated", "请先登录");
  }

  return verifyWithGateway(request);
}

function parseSimToken(token: string): CloudbaseIdentity {
  const raw = token.slice(SIMULATE_PREFIX.length);
  const separator = raw.indexOf(":");
  if (separator === -1) {
    throw new AuthenticationError("unauthenticated", "请先登录");
  }
  const uid = raw.slice(0, separator).trim();
  const nickName = raw.slice(separator + 1).trim();
  if (!uid || !nickName) {
    throw new AuthenticationError("unauthenticated", "请先登录");
  }
  return { uid, nickName, email: null };
}

/**
 * Production verification: rely on the gateway-injected, server-validated
 * identity header. This keeps the Edge middleware free of any Node SDK and
 * fails closed when the header is absent (e.g. misconfigured gateway or an
 * unauthenticated request that slipped past the gateway).
 */
async function verifyWithGateway(request: Request): Promise<CloudbaseIdentity> {
  const contextHeader = request.headers.get(CLOUDBASE_GATEWAY_HEADERS.context);
  const context = contextHeader
    ? decodeBase64Json(contextHeader)
    : null;

  const uid =
    (typeof context?.uid === "string" ? context.uid : null) ??
    request.headers.get(CLOUDBASE_GATEWAY_HEADERS.uid) ??
    null;

  if (!uid) {
    throw new AuthenticationError("unauthenticated", "请先登录");
  }

  const nickName =
    (typeof context?.nickName === "string" ? context.nickName : null) ??
    (typeof context?.nick_name === "string" ? context.nick_name : null) ??
    "";
  const email =
    typeof context?.email === "string" ? context.email : null;

  return { uid, nickName: nickName || uid, email: email ?? null };
}

/** Base64(JSON) → object, tolerant of URL-safe alphabet; returns null on any error. */
function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readCloudbaseToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (
    authorization &&
    authorization.toLowerCase().startsWith("bearer ")
  ) {
    const value = authorization.slice(7).trim();
    if (value) return value;
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  return cookieValue(cookieHeader, CLOUDBASE_TOKEN_COOKIE);
}

function cookieValue(cookie: string, name: string): string | null {
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function setCloudbaseAuthCookie(
  request: Request,
  value: string,
  maxAgeSeconds = 30 * 24 * 60 * 60,
): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${CLOUDBASE_TOKEN_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCloudbaseAuthCookie(request?: Request): string {
  const secure = request && new URL(request.url).protocol === "https:";
  return [
    `${CLOUDBASE_TOKEN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}
