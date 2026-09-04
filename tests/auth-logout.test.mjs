import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_LOGOUT_PATH,
  authLogoutPath,
  handleLogout,
  safeAuthReturnTo,
} from "../lib/auth/logout.ts";

function securePost(url, init = {}) {
  const origin = new URL(url).origin;
  return new Request(url, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-ttq-request": "ledger-v1",
      ...init.headers,
    },
    body: "{}",
  });
}

test("return_to 只接受同源相对路径，并拒绝认证循环与控制字符", () => {
  assert.equal(safeAuthReturnTo("/ledger?tab=more#account"), "/ledger?tab=more#account");
  assert.equal(safeAuthReturnTo("https://evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("//evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/\\evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%2f%2fevil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%5cevil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%0d%0aLocation:https://evil.test"), "/");
  assert.equal(safeAuthReturnTo("/auth/logout"), "/");
  assert.equal(safeAuthReturnTo("/api/local-auth/signin"), "/");
});

test("认证 UI 使用稳定通用退出入口", () => {
  assert.equal(AUTH_LOGOUT_PATH, "/auth/logout");
  assert.equal(
    authLogoutPath("/ledger?tab=more"),
    "/auth/logout?return_to=%2Fledger%3Ftab%3Dmore",
  );
});

test("local 退出仅在显式 development loopback 模式清 cookie", async () => {
  const request = securePost(
    "http://localhost:3000/auth/logout?return_to=%2Fledger%3Ftab%3Dmore",
  );
  const response = await handleLogout(request, {
    authMode: "local",
    nodeEnv: "development",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { location: "/ledger?tab=more" });
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^ttq_local_auth=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/,
  );
  assert.equal(response.headers.get("strict-transport-security"), null);

  for (const [url, nodeEnv] of [
    ["http://localhost:3000/auth/logout", "production"],
    ["http://localhost:3000/auth/logout", "staging"],
    ["http://localhost:3000/auth/logout", ""],
    ["https://test.example/auth/logout", "development"],
  ]) {
    const rejected = await handleLogout(securePost(url), {
      authMode: "local",
      nodeEnv,
    });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, "auth_mode_unavailable");
  }
});

test("本地 logout 拒绝跨源、缺标记请求与未知模式", async () => {
  const crossOrigin = await handleLogout(
    securePost("http://localhost:3000/auth/logout", {
      headers: { origin: "https://evil.example" },
    }),
    { authMode: "local", nodeEnv: "development" },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "origin_not_allowed");

  const missingMarker = await handleLogout(
    securePost("http://localhost:3000/auth/logout", {
      headers: { "x-ttq-request": "" },
    }),
    { authMode: "local", nodeEnv: "development" },
  );
  assert.equal(missingMarker.status, 403);

  const unknown = await handleLogout(
    securePost("https://app.example/auth/logout"),
    { authMode: "unexpected" },
  );
  assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).error.code, "auth_mode_invalid");
});
