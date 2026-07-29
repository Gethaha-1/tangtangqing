import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_LOGOUT_PATH,
  authLogoutPath,
  chatGPTLogoutProvider,
  handleLogout,
  safeAuthReturnTo,
} from "../lib/auth/logout.ts";

test("return_to 只接受同源相对路径，并拒绝认证循环与控制字符", () => {
  assert.equal(
    safeAuthReturnTo("/ledger?tab=more#account"),
    "/ledger?tab=more#account",
  );
  assert.equal(safeAuthReturnTo("https://evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("//evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/\\evil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%2f%2fevil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%5cevil.test/ledger"), "/");
  assert.equal(safeAuthReturnTo("/%0d%0aLocation:https://evil.test"), "/");
  assert.equal(safeAuthReturnTo("/auth/logout"), "/");
  assert.equal(safeAuthReturnTo("/auth/logout/"), "/");
  assert.equal(safeAuthReturnTo("/%61uth/logout"), "/");
  assert.equal(safeAuthReturnTo("/signin-with-chatgpt"), "/");
  assert.equal(safeAuthReturnTo("/signout-with-chatgpt?return_to=/ledger"), "/");
  assert.equal(safeAuthReturnTo("/callback"), "/");
});

test("认证 UI 使用稳定通用退出入口，provider 只在服务端适配", () => {
  assert.equal(AUTH_LOGOUT_PATH, "/auth/logout");
  assert.equal(
    authLogoutPath("/ledger?tab=more"),
    "/auth/logout?return_to=%2Fledger%3Ftab%3Dmore",
  );
  assert.equal(authLogoutPath("//evil.test"), "/auth/logout?return_to=%2F");
  assert.equal(
    chatGPTLogoutProvider.signOutLocation("/ledger"),
    "/signout-with-chatgpt?return_to=%2Fledger",
  );
});

test("生产退出委托 Sites dispatcher，且响应禁止缓存", () => {
  const response = handleLogout(
    new Request(
      "https://tangtangqing.example/auth/logout?return_to=%2Fledger%3Ftab%3Dmore",
    ),
  );
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/signout-with-chatgpt?return_to=%2Fledger%3Ftab%3Dmore",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("本地退出只清理 HttpOnly 测试 cookie，不占用 dispatcher 路由", () => {
  const response = handleLogout(
    new Request(
      "http://localhost:3000/auth/logout?return_to=%2Fledger%3Ftab%3Dmore",
    ),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/ledger?tab=more");
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^ttq_local_auth=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/,
  );
});

test("恶意 return_to 在交给 provider 前降级到首页", () => {
  const response = handleLogout(
    new Request(
      "https://tangtangqing.example/auth/logout?return_to=https%3A%2F%2Fevil.test",
    ),
  );
  assert.equal(
    response.headers.get("location"),
    "/signout-with-chatgpt?return_to=%2F",
  );
});
