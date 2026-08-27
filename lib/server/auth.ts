export const AUTH_MODE_ENV = "TTQ_AUTH_MODE";
export const INTERNAL_AUTH_SECRET_ENV = "TTQ_INTERNAL_AUTH_SECRET";

export type AuthMode = "sites" | "local" | "cloudbase";
export type PrincipalIssuer = AuthMode;

/**
 * Provider-neutral identity at the application boundary. `subject` is an
 * opaque, provider-scoped identifier; business rows continue to use the
 * application's internal user id.
 */
export type Principal = {
  issuer: PrincipalIssuer;
  subject: string;
  displayName: string;
  email: string | null;
  loginName: string | null;
};

// Kept as a source-compatible alias while repository code migrates to the
// provider-neutral name.
export type TrustedIdentity = Principal;

export const INTERNAL_AUTH_HEADERS = {
  mode: "x-ttq-auth-mode",
  proof: "x-ttq-auth-proof",
  issuer: "x-ttq-auth-issuer",
  subject: "x-ttq-auth-subject",
  displayName: "x-ttq-auth-display-name",
  email: "x-ttq-auth-email",
  loginName: "x-ttq-auth-login-name",
} as const;

export const SITES_AUTH_HEADERS = {
  subject: "oai-authenticated-user-id",
  email: "oai-authenticated-user-email",
  displayName: "oai-authenticated-user-full-name",
  displayNameEncoding: "oai-authenticated-user-full-name-encoding",
} as const;

export const LOCAL_TEST_PRINCIPAL = {
  issuer: "local",
  subject: "local-test-owner-v1",
  displayName: "本地测试车主",
  email: null,
  loginName: "13800000000",
} satisfies Principal;

export class AuthenticationError extends Error {
  readonly code:
    | "auth_mode_invalid"
    | "auth_mode_unavailable"
    | "auth_boundary_invalid"
    | "unauthenticated";

  constructor(
    code:
      | "auth_mode_invalid"
      | "auth_mode_unavailable"
      | "auth_boundary_invalid"
      | "unauthenticated" = "unauthenticated",
    message = "请先登录",
  ) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export type PrincipalOptions = {
  authMode?: string | null;
  nodeEnv?: string | null;
  internalSecret?: string | null;
};

/**
 * Reads only worker-minted internal assertions. The edge worker removes these
 * headers from the public request before a provider adapter can mint them.
 */
export function getTrustedPrincipal(
  request: Request,
  options: PrincipalOptions = {},
): Principal {
  const mode = resolveAuthMode(options.authMode);
  const secret = resolveInternalAuthSecret(options.internalSecret);
  const proof = request.headers.get(INTERNAL_AUTH_HEADERS.proof) ?? "";
  if (!constantTimeEqual(proof, secret)) {
    throw new AuthenticationError(
      "auth_boundary_invalid",
      "认证边界校验失败",
    );
  }
  if (
    mode === "local" &&
    (!isLoopbackHostname(new URL(request.url).hostname) ||
      resolveNodeEnv(options.nodeEnv) !== "development")
  ) {
    throw new AuthenticationError(
      "auth_mode_unavailable",
      "本地测试认证只允许显式 development loopback 环境",
    );
  }

  const issuer = clean(request.headers.get(INTERNAL_AUTH_HEADERS.issuer));

  // A claim minted by one adapter can never be consumed in another mode.
  if (issuer !== mode) throw new AuthenticationError();

  const subject = clean(request.headers.get(INTERNAL_AUTH_HEADERS.subject));
  const displayName = decodeInternalClaim(
    request.headers.get(INTERNAL_AUTH_HEADERS.displayName),
  );
  if (!subject || !displayName) throw new AuthenticationError();

  const email = nullableClaim(
    request.headers.get(INTERNAL_AUTH_HEADERS.email),
  );
  const loginName = nullableClaim(
    request.headers.get(INTERNAL_AUTH_HEADERS.loginName),
  );

  if (mode === "local") {
    // Local mode exposes one fixed test account. Caller-controlled phone/email
    // values can therefore never select an application identity.
    if (
      subject !== LOCAL_TEST_PRINCIPAL.subject ||
      displayName !== LOCAL_TEST_PRINCIPAL.displayName ||
      email !== null ||
      loginName !== LOCAL_TEST_PRINCIPAL.loginName
    ) {
      throw new AuthenticationError();
    }
    return LOCAL_TEST_PRINCIPAL;
  }

  return {
    issuer,
    subject,
    displayName,
    email: email?.toLowerCase() ?? null,
    loginName,
  };
}

export function getTrustedIdentity(
  request: Request,
  options: PrincipalOptions = {},
): Principal {
  return getTrustedPrincipal(request, options);
}

export function resolveAuthMode(value?: string | null): AuthMode {
  const configured = (value ?? runtimeAuthMode()).trim().toLowerCase();
  if (!configured) {
    throw new AuthenticationError(
      "auth_mode_invalid",
      `${AUTH_MODE_ENV} 必须显式配置`,
    );
  }
  if (
    configured !== "sites" &&
    configured !== "local" &&
    configured !== "cloudbase"
  ) {
    throw new AuthenticationError(
      "auth_mode_invalid",
      `${AUTH_MODE_ENV} 配置无效`,
    );
  }
  return configured;
}

export function resolveInternalAuthSecret(value?: string | null): string {
  const configured = (value ?? runtimeInternalSecret()).trim();
  if (configured.length < 32 || /[\r\n\u0000]/u.test(configured)) {
    throw new AuthenticationError(
      "auth_boundary_invalid",
      `${INTERNAL_AUTH_SECRET_ENV} 必须显式配置为至少 32 个字符`,
    );
  }
  return configured;
}

function runtimeAuthMode(): string {
  return typeof process === "undefined"
    ? ""
    : process.env[AUTH_MODE_ENV] ?? "";
}

function runtimeInternalSecret(): string {
  return typeof process === "undefined"
    ? ""
    : process.env[INTERNAL_AUTH_SECRET_ENV] ?? "";
}

export function resolveNodeEnv(value?: string | null): string {
  return (value ?? (
    typeof process === "undefined" ? "" : process.env.NODE_ENV ?? ""
  )).trim().toLowerCase();
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function clean(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 320 || /[\r\n\u0000]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function nullableClaim(value: string | null): string | null {
  const normalized = clean(value);
  return normalized === "-" ? null : normalized;
}

function decodeInternalClaim(value: string | null): string | null {
  const encoded = clean(value);
  if (!encoded) return null;
  try {
    return clean(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}
