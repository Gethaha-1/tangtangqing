import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AuthenticationError,
  getTrustedPrincipal,
  INTERNAL_AUTH_HEADERS,
  LOCAL_TEST_PRINCIPAL,
} from "../lib/server/auth.ts";
import {
  adaptAuthenticationAtEdge,
  localAuthCookie,
} from "../lib/server/auth-edge.ts";
import {
  enforceMutationRequest,
  MAX_JSON_BYTES,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
} from "../lib/server/http-security.ts";

const INTERNAL_SECRET = "test-only-internal-auth-secret-1234567890";

function authOptions(authMode, nodeEnv = "development") {
  return { authMode, nodeEnv, internalSecret: INTERNAL_SECRET };
}

function mutation(url, init = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json; charset=utf-8",
      "x-ttq-request": "ledger-v1",
      ...init.headers,
    },
    body: init.body ?? "{}",
    ...(init.duplex ? { duplex: init.duplex } : {}),
  });
}

test("本地适配器先剥离伪造内部头和已退役 provider 头，再铸造固定测试 Principal", async () => {
  const publicRequest = mutation("https://app.example/api/bootstrap", {
    headers: {
      "oai-authenticated-user-id": "usr_123",
      "oai-authenticated-user-email": " Owner@Example.COM ",
      "oai-authenticated-user-full-name": "%E8%BD%A6%E4%B8%BB",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      [INTERNAL_AUTH_HEADERS.mode]: "local",
      [INTERNAL_AUTH_HEADERS.issuer]: "local",
      [INTERNAL_AUTH_HEADERS.subject]: "attacker",
    },
  });
  const localRequest = mutation("http://localhost:3000/api/bootstrap", {
    headers: Object.fromEntries(publicRequest.headers),
  });
  const adapted = await adaptAuthenticationAtEdge(localRequest, {
    ...authOptions("local"),
    localAutoSignIn: true,
  });
  assert.equal(adapted.headers.get("oai-authenticated-user-email"), null);
  assert.equal(adapted.headers.get("x-cloudbase-context"), null);
  assert.deepEqual(
    getTrustedPrincipal(adapted, authOptions("local")),
    LOCAL_TEST_PRINCIPAL,
  );
});

test("已退役的 Sites/CloudBase 模式 fail closed，local 不信任其公开身份头", async () => {
  const oai = {
    "oai-authenticated-user-id": "usr_123",
    "oai-authenticated-user-email": "owner@example.com",
  };
  const localNoCookie = await adaptAuthenticationAtEdge(
    mutation("http://localhost:3000/api/bootstrap", { headers: oai }),
    authOptions("local", "development"),
  );
  assert.equal(localNoCookie.headers.get(INTERNAL_AUTH_HEADERS.subject), null);
  assert.throws(
    () => getTrustedPrincipal(localNoCookie, authOptions("local", "development")),
    AuthenticationError,
  );

  for (const retiredMode of ["sites", "cloudbase", "unknown"]) {
    await assert.rejects(
      adaptAuthenticationAtEdge(
        mutation("https://app.example/api/bootstrap", { headers: oai }),
        { ...authOptions(retiredMode) },
      ),
      (error) =>
        error instanceof AuthenticationError && error.code === "auth_mode_invalid",
      retiredMode,
    );
  }
});

test("local 只接受显式 development loopback 与固定测试 subject，手机号不作 subject", async () => {
  const request = mutation("http://localhost:3000/api/bootstrap", {
    headers: {
      cookie: "ttq_local_auth=local-test-owner-v1",
      "oai-authenticated-user-id": "attacker",
      "oai-authenticated-user-email": "attacker@example.com",
    },
  });
  const adapted = await adaptAuthenticationAtEdge(request, {
    ...authOptions("local"),
  });
  assert.deepEqual(
    getTrustedPrincipal(adapted, authOptions("local")),
    LOCAL_TEST_PRINCIPAL,
  );
  assert.equal(LOCAL_TEST_PRINCIPAL.loginName, "13800000000");
  assert.notEqual(LOCAL_TEST_PRINCIPAL.subject, LOCAL_TEST_PRINCIPAL.loginName);

  await assert.rejects(
    adaptAuthenticationAtEdge(request, {
      ...authOptions("local", "production"),
    }),
    /development loopback/,
  );
  for (const nodeEnv of [undefined, "", "test", "staging", "unexpected"]) {
    await assert.rejects(
      adaptAuthenticationAtEdge(request, {
        authMode: "local",
        nodeEnv,
        internalSecret: INTERNAL_SECRET,
      }),
      /development loopback/,
      `nodeEnv=${String(nodeEnv)}`,
    );
  }
  await assert.rejects(
    adaptAuthenticationAtEdge(
      mutation("https://trial.example/api/bootstrap", {
        headers: { cookie: "ttq_local_auth=local-test-owner-v1" },
      }),
      authOptions("local", "development"),
    ),
    /development loopback/,
  );
  assert.match(localAuthCookie(request), /HttpOnly; SameSite=Strict; Max-Age=1800$/);
  assert.doesNotMatch(localAuthCookie(request), /Secure/);
  assert.match(
    localAuthCookie(new Request("https://localhost/api/local-auth/signin")),
    /SameSite=Strict; Secure; Max-Age=1800$/,
  );
});

test("本地自动登录仅由显式服务端选项启用，仍受 development loopback 限制", async () => {
  const manual = await adaptAuthenticationAtEdge(
    mutation("http://localhost:3000/api/bootstrap"),
    authOptions("local"),
  );
  assert.equal(manual.headers.get(INTERNAL_AUTH_HEADERS.subject), null);

  const automatic = await adaptAuthenticationAtEdge(
    mutation("http://localhost:3000/api/bootstrap"),
    {
      ...authOptions("local"),
      localAutoSignIn: true,
    },
  );
  assert.deepEqual(
    getTrustedPrincipal(automatic, authOptions("local")),
    LOCAL_TEST_PRINCIPAL,
  );

  await assert.rejects(
    adaptAuthenticationAtEdge(
      mutation("http://localhost:3000/api/bootstrap"),
      {
        ...authOptions("local", "production"),
        localAutoSignIn: true,
      },
    ),
    /development loopback/,
  );
  await assert.rejects(
    adaptAuthenticationAtEdge(
      mutation("https://trial.example/api/bootstrap"),
      {
        ...authOptions("local"),
        localAutoSignIn: true,
      },
    ),
    /development loopback/,
  );
});

test("直达 Route 的伪造内部身份没有部署 secret proof 时 fail-closed", () => {
  const forged = mutation("https://app.example/api/bootstrap", {
    headers: {
      [INTERNAL_AUTH_HEADERS.mode]: "supabase",
      [INTERNAL_AUTH_HEADERS.issuer]: "supabase",
      [INTERNAL_AUTH_HEADERS.subject]: "attacker",
      [INTERNAL_AUTH_HEADERS.displayName]: "attacker",
      [INTERNAL_AUTH_HEADERS.email]: "-",
      [INTERNAL_AUTH_HEADERS.loginName]: "-",
      [INTERNAL_AUTH_HEADERS.proof]: "attacker-chosen-proof-that-is-long-enough",
    },
  });
  assert.throws(
    () => getTrustedPrincipal(forged, authOptions("supabase")),
    (error) =>
      error instanceof AuthenticationError &&
      error.code === "auth_boundary_invalid",
  );
  assert.throws(
    () => getTrustedPrincipal(forged, {
      authMode: "supabase",
      internalSecret: "",
    }),
    (error) =>
      error instanceof AuthenticationError &&
      error.code === "auth_boundary_invalid",
  );
});

test("mutation 门禁精确校验 Origin、Fetch Metadata、JSON 与自定义头", () => {
  assert.doesNotThrow(() => enforceMutationRequest(
    mutation("https://app.example/api/sync"),
  ));

  const invalid = [
    ["origin_not_allowed", { headers: { origin: "https://evil.example" } }],
    ["cross_site_request", { headers: { "sec-fetch-site": "cross-site" } }],
    ["unsupported_media_type", { headers: { "content-type": "text/plain" } }],
    ["request_marker_missing", { headers: { "x-ttq-request": "" } }],
  ];
  for (const [code, init] of invalid) {
    assert.throws(
      () => enforceMutationRequest(mutation("https://app.example/api/sync", init)),
      (error) => error instanceof RequestSecurityError && error.code === code,
      code,
    );
  }
});

test("JSON body 流式计数，不依赖 Content-Length，chunked 超过 2 MiB 返回 413", async () => {
  const valid = mutation("https://app.example/api/sync", {
    body: JSON.stringify({ operationId: "write-12345678" }),
  });
  assert.deepEqual(await readJsonWithinLimit(valid), {
    operationId: "write-12345678",
  });

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_JSON_BYTES));
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const oversized = mutation("https://app.example/api/sync", {
    body: stream,
    duplex: "half",
  });
  await assert.rejects(
    () => readJsonWithinLimit(oversized),
    (error) =>
      error instanceof RequestSecurityError &&
      error.code === "payload_too_large" &&
      error.status === 413,
  );
});

test("安全响应头 no-store/nosniff/frame deny/no-referrer，HSTS 仅 https", () => {
  const httpsResponse = secureJson(
    new Request("https://app.example/api/bootstrap"),
    { ok: true },
    200,
  );
  assert.equal(httpsResponse.headers.get("cache-control"), "no-store");
  assert.equal(httpsResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(httpsResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(httpsResponse.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(httpsResponse.headers.get("referrer-policy"), "no-referrer");
  assert.match(httpsResponse.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.ok(httpsResponse.headers.get("strict-transport-security"));

  const httpResponse = secureJson(
    new Request("http://localhost:3000/api/bootstrap"),
    { ok: true },
    200,
  );
  assert.equal(httpResponse.headers.get("strict-transport-security"), null);
});

test("bootstrap/logout 路由 POST-only，Next proxy 明确接入 adapter 与全响应安全头", () => {
  const bootstrap = readFileSync(
    new URL("../app/api/bootstrap/route.ts", import.meta.url),
    "utf8",
  );
  const logout = readFileSync(
    new URL("../app/auth/logout/route.ts", import.meta.url),
    "utf8",
  );
  const sync = readFileSync(
    new URL("../app/api/sync/route.ts", import.meta.url),
    "utf8",
  );
  const location = readFileSync(
    new URL("../app/api/location/reverse/route.ts", import.meta.url),
    "utf8",
  );
  const proxy = readFileSync(
    new URL("../proxy.ts", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /export async function GET[\s\S]*status: 405/);
  assert.match(bootstrap, /headers: \{ allow: "POST" \}/);
  assert.match(bootstrap, /export async function POST/);
  assert.match(
    bootstrap,
    /await requestIdentity\(request\)/,
  );
  assert.match(sync, /await requestIdentity\(request\)/);
  assert.match(location, /export async function GET[\s\S]*status: 405/);
  assert.match(location, /enforceMutationRequest\(request\)/);
  assert.match(location, /await requestIdentity\(request\)/);
  assert.match(location, /readJsonWithinLimit\(request, 1_024\)/);
  assert.doesNotMatch(location, /TTQ_AMAP_WEB_SERVICE_KEY[^\n]*secureJson/);
  assert.doesNotMatch(logout, /export function GET/);
  assert.match(logout, /export function POST/);
  // The Next.js proxy must wire up every authentication primitive it depends on.
  assert.match(proxy, /export async function proxy\(request/);
  assert.match(proxy, /adaptAuthenticationAtEdge\(request/);
  assert.match(proxy, /safeAuthReturnTo\(/);
  assert.match(proxy, /resolveAuthMode\(/);
  assert.match(proxy, /localAuthCookie\(/);
  assert.match(proxy, /enforceMutationRequest\(/);
  assert.match(proxy, /secureJson\(/);
});
