import {
  AuthenticationError,
  INTERNAL_AUTH_HEADERS,
  isLoopbackHostname,
  LOCAL_TEST_PRINCIPAL,
  resolveAuthMode,
  resolveInternalAuthSecret,
  resolveNodeEnv,
  SITES_AUTH_HEADERS,
  type AuthMode,
  type PrincipalIssuer,
} from "./auth.ts";
import { LOCAL_AUTH_COOKIE } from "../auth/logout.ts";
import {
  CLOUDBASE_GATEWAY_HEADERS,
  verifyCloudbaseIdentity,
} from "./cloudbase-auth.ts";

const SITES_NAME_ENCODING = "percent-encoded-utf-8";
const LOCAL_COOKIE_VALUE = "local-test-owner-v1";

export type EdgeAuthOptions = {
  authMode?: string | null;
  nodeEnv?: string | null;
  internalSecret?: string | null;
  localAutoSignIn?: boolean;
};

/**
 * Converts one trusted provider assertion into internal headers. Every public
 * identity header is removed first, including headers that imitate our
 * internal boundary.
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

  if (mode === "sites") {
    mintSitesHeaders(publicHeaders, headers);
  } else if (
    mode === "local" &&
    (options.localAutoSignIn === true ||
      cookieValue(publicHeaders.get("cookie"), LOCAL_AUTH_COOKIE) ===
        LOCAL_COOKIE_VALUE)
  ) {
    mintInternalHeaders(headers, LOCAL_TEST_PRINCIPAL);
  } else if (mode === "cloudbase") {
    // Trust the CloudBase gateway-injected identity (x-cloudbase-context) and
    // mint an internal identity. Any failure is swallowed on purpose: the
    // request simply carries no identity, so getTrustedPrincipal treats it as
    // unauthenticated (fail-closed).
    try {
      const identity = await verifyCloudbaseIdentity(request, {
        authMode: options.authMode,
        nodeEnv: options.nodeEnv,
        internalSecret: options.internalSecret,
      });
      mintInternalHeaders(headers, {
        issuer: "cloudbase",
        subject: identity.uid,
        displayName: identity.nickName || identity.uid,
        email: identity.email,
        loginName: identity.email,
      });
    } catch {
      // No identity minted.
    }
    // Defense in depth: drop the raw gateway assertion so it can never be
    // forwarded to internal services or replayed by a downstream handler.
    for (const name of Object.values(CLOUDBASE_GATEWAY_HEADERS)) {
      headers.delete(name);
    }
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
  for (const name of Object.values(SITES_AUTH_HEADERS)) {
    headers.delete(name);
  }
}

function mintSitesHeaders(source: Headers, destination: Headers): void {
  const email = source.get(SITES_AUTH_HEADERS.email)?.trim().toLowerCase();
  const stableId = source.get(SITES_AUTH_HEADERS.subject)?.trim();
  if (!email || !stableId || invalidClaim(email) || invalidClaim(stableId)) {
    return;
  }

  const encodedName = source.get(SITES_AUTH_HEADERS.displayName)?.trim();
  const name =
    encodedName &&
    source.get(SITES_AUTH_HEADERS.displayNameEncoding) === SITES_NAME_ENCODING
      ? safeDecode(encodedName)
      : null;
  mintInternalHeaders(destination, {
    issuer: "sites",
    subject: stableId,
    // Email remains a request-only login hint. Missing optional profile names
    // must never make an email flow into users.display_name or fleet.name.
    displayName: name || "车主",
    email,
    loginName: email,
  });
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

function safeDecode(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded && !invalidClaim(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function invalidClaim(value: string): boolean {
  return value.length > 320 || /[\r\n\u0000]/u.test(value);
}
