import {
  AuthenticationError,
  INTERNAL_AUTH_HEADERS,
  isLoopbackHostname,
  LOCAL_TEST_PRINCIPAL,
  resolveAuthMode,
  resolveInternalAuthSecret,
  resolveNodeEnv,
  type AuthMode,
  type PrincipalIssuer,
} from "./auth.ts";
import { LOCAL_AUTH_COOKIE } from "../auth/logout.ts";

const LOCAL_COOKIE_VALUE = "local-test-owner-v1";

export type EdgeAuthOptions = {
  authMode?: string | null;
  nodeEnv?: string | null;
  internalSecret?: string | null;
  localAutoSignIn?: boolean;
};

/**
 * Mints the strictly local development identity after removing every public
 * identity header, including headers left over from retired providers.
 */
export async function adaptAuthenticationAtEdge(
  request: Request,
  options: EdgeAuthOptions = {},
): Promise<Request> {
  const mode = resolveAuthMode(options.authMode);
  const internalSecret = resolveInternalAuthSecret(options.internalSecret);
  assertModeMayServeRequest(request, mode, options.nodeEnv);

  const publicHeaders = request.headers;
  const headers = new Headers(publicHeaders);
  stripIdentityHeaders(headers);
  headers.set(INTERNAL_AUTH_HEADERS.mode, mode);
  headers.set(INTERNAL_AUTH_HEADERS.proof, internalSecret);

  if (
    mode === "local" &&
    (options.localAutoSignIn === true ||
      cookieValue(publicHeaders.get("cookie"), LOCAL_AUTH_COOKIE) ===
        LOCAL_COOKIE_VALUE)
  ) {
    mintInternalHeaders(headers, LOCAL_TEST_PRINCIPAL);
  }

  return new Request(request, { headers });
}

export function assertModeMayServeRequest(
  request: Request,
  mode: AuthMode,
  nodeEnv?: string | null,
): void {
  if (
    mode === "local" &&
    (resolveNodeEnv(nodeEnv) !== "development" ||
      !isLoopbackHostname(new URL(request.url).hostname))
  ) {
    throw new AuthenticationError(
      "auth_mode_unavailable",
      "本地测试认证只允许显式 development loopback 环境",
    );
  }
}

export function localAuthCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${LOCAL_AUTH_COOKIE}=${LOCAL_COOKIE_VALUE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Max-Age=1800",
  ].filter(Boolean).join("; ");
}

export function stripIdentityHeaders(headers: Headers): void {
  for (const name of Object.values(INTERNAL_AUTH_HEADERS)) {
    headers.delete(name);
  }
  for (const name of Array.from(headers.keys())) {
    if (
      name.startsWith("oai-authenticated-") ||
      name.startsWith("x-cloudbase-") ||
      name.startsWith("x-wx-")
    ) {
      headers.delete(name);
    }
  }
}

function mintInternalHeaders(
  headers: Headers,
  principal: {
    issuer: PrincipalIssuer;
    subject: string;
    displayName: string;
    email: string | null;
    loginName: string | null;
  },
): void {
  headers.set(INTERNAL_AUTH_HEADERS.issuer, principal.issuer);
  headers.set(INTERNAL_AUTH_HEADERS.subject, principal.subject);
  headers.set(
    INTERNAL_AUTH_HEADERS.displayName,
    encodeURIComponent(principal.displayName),
  );
  headers.set(INTERNAL_AUTH_HEADERS.email, principal.email ?? "-");
  headers.set(INTERNAL_AUTH_HEADERS.loginName, principal.loginName ?? "-");
}

function cookieValue(cookie: string | null, name: string): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
