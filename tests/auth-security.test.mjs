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

test("Sites adapter 先剥离伪造内部头，再从稳定 Sites subject 重铸 Principal", () => {
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
  const adapted = adaptAuthenticationAtEdge(publicRequest, {
    ...authOptions("sites"),
  });
  assert.equal(adapted.headers.get("oai-authenticated-user-email"), null);
  assert.deepEqual(getTrustedPrincipal(adapted, authOptions("sites")), {
    issuer: "sites",
    subject: "usr_123",
    displayName: "车主",
    email: "owner@example.com",
    loginName: "owner@example.com",
  });
});

test("Sites 缺少可选全名时使用非联系占位名，不把 email 变成业务显示名", () => {
  const adapted = adaptAuthenticationAtEdge(
    mutation("https://app.example/api/bootstrap", {
      headers: {
        "oai-authenticated-user-id": "usr_without_name",
        "oai-authenticated-user-email": "private@example.com",
      },
    }),
    authOptions("sites"),
  );
  const principal = getTrustedPrincipal(adapted, authOptions("sites"));
  assert.equal(principal.displayName, "车主");
  assert.equal(principal.email, "private@example.com");
  assert.notEqual(principal.displayName, principal.email);
});

test("Sites/local/cloudbase adapter 互斥，非 Sites 模式绝不信任 OAI 头", () => {
  const oai = {
    "oai-authenticated-user-id": "usr_123",
    "oai-authenticated-user-email": "owner@example.com",
  };
  const localNoCookie = adaptAuthenticationAtEdge(
    mutation("http://localhost:3000/api/bootstrap", { headers: oai }),
    authOptions("local", "development"),
  );
  assert.equal(localNoCookie.headers.get(INTERNAL_AUTH_HEADERS.subject), null);
  assert.throws(
    () => getTrustedPrincipal(localNoCookie, authOptions("local", "development")),
    AuthenticationError,
  );

  const cloudbase = adaptAuthenticationAtEdge(
    mutation("https://app.example/api/bootstrap", { headers: oai }),
    authOptions("cloudbase", "production"),
  );
  assert.equal(cloudbase.headers.get(INTERNAL_AUTH_HEADERS.subject), null);
  assert.throws(
    () => getTrustedPrincipal(cloudbase, authOptions("cloudbase", "production")),
    (error) =>
      error instanceof AuthenticationError &&
      error.code === "auth_mode_unavailable",
  );

  assert.throws(
    () => adaptAuthenticationAtEdge(
      mutation("https://app.example/api/bootstrap", { headers: oai }),
      { ...authOptions("unknown") },
    ),
    (error) =>
      error instanceof AuthenticationError && error.code === "auth_mode_invalid",
  );
});

test("local 只接受显式 development loopback 与固定测试 subject，手机号不作 subject", () => {
  const request = mutation("http://localhost:3000/api/bootstrap", {
    headers: {
      cookie: "ttq_local_auth=local-test-owner-v1",
      "oai-authenticated-user-id": "attacker",
      "oai-authenticated-user-email": "attacker@example.com",
    },
  });
  const adapted = adaptAuthenticationAtEdge(request, {
    ...authOptions("local"),
  });
  assert.deepEqual(
    getTrustedPrincipal(adapted, authOptions("local")),
    LOCAL_TEST_PRINCIPAL,
  );
  assert.equal(LOCAL_TEST_PRINCIPAL.loginName, "13800000000");
  assert.notEqual(LOCAL_TEST_PRINCIPAL.subject, LOCAL_TEST_PRINCIPAL.loginName);

  assert.throws(
    () => adaptAuthenticationAtEdge(request, {
      ...authOptions("local", "production"),
    }),
    /development loopback/,
  );
  for (const nodeEnv of [undefined, "", "test", "staging", "unexpected"]) {
    assert.throws(
      () => adaptAuthenticationAtEdge(request, {
        authMode: "local",
        nodeEnv,
        internalSecret: INTERNAL_SECRET,
      }),
      /development loopback/,
      `nodeEnv=${String(nodeEnv)}`,
    );
  }
  assert.throws(
    () => adaptAuthenticationAtEdge(
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

test("直达 Route 的伪造内部身份没有部署 secret proof 时 fail-closed", () => {
  const forged = mutation("https://app.example/api/bootstrap", {
    headers: {
      [INTERNAL_AUTH_HEADERS.mode]: "sites",
      [INTERNAL_AUTH_HEADERS.issuer]: "sites",
      [INTERNAL_AUTH_HEADERS.subject]: "attacker",
      [INTERNAL_AUTH_HEADERS.displayName]: "attacker",
      [INTERNAL_AUTH_HEADERS.email]: "-",
      [INTERNAL_AUTH_HEADERS.loginName]: "-",
      [INTERNAL_AUTH_HEADERS.proof]: "attacker-chosen-proof-that-is-long-enough",
    },
  });
  assert.throws(
    () => getTrustedPrincipal(forged, authOptions("sites")),
    (error) =>
      error instanceof AuthenticationError &&
      error.code === "auth_boundary_invalid",
  );
  assert.throws(
    () => getTrustedPrincipal(forged, {
      authMode: "sites",
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

test("bootstrap/logout 路由 POST-only，worker 明确接入 adapter 与全响应安全头", () => {
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
  const worker = readFileSync(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /export async function GET[\s\S]*status: 405/);
  assert.match(bootstrap, /headers: \{ allow: "POST" \}/);
  assert.match(bootstrap, /export async function POST/);
  assert.match(
    bootstrap,
    /getTrustedPrincipal\(request, serverAuthOptions\(\)\)/,
  );
  assert.match(sync, /getTrustedPrincipal\(request, serverAuthOptions\(\)\)/);
  assert.doesNotMatch(logout, /export function GET/);
  assert.match(logout, /export function POST/);
  assert.match(worker, /adaptAuthenticationAtEdge\(originalRequest/);
  assert.match(worker, /withSecurityHeaders\(response, originalRequest\)/);
  assert.match(worker, /originalRequest\.method !== "POST"/);
});
