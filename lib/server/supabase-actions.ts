import { safeAuthReturnTo } from "../auth/logout.ts";
import { AuthenticationError, resolveAuthMode } from "./auth.ts";
import { enforceMutationRequest, readJsonWithinLimit, RequestSecurityError, secureJson } from "./http-security.ts";
import { createSupabaseContext, principalFromSupabaseUser } from "./supabase-auth.ts";

/** No public signup endpoint: accounts are provisioned explicitly. */
export async function handleSupabaseAction(request: Request, action: "signin" | "signout", transport: typeof fetch = fetch): Promise<Response> {
  try {
    if (resolveAuthMode() !== "supabase") return secureJson(request, { error: { code: "not_found", message: "入口未启用" } }, 404);
    enforceMutationRequest(request);
    const input = await readJsonWithinLimit(request, 8192);
    const context = createSupabaseContext(request, process.env, transport);
    if (action === "signin") {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new RequestSecurityError("invalid_credentials", "请填写邮箱和密码", 400);
      const { email, password } = input as Record<string, unknown>;
      if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== "string" || !password || password.length > 1024) {
        throw new RequestSecurityError("invalid_credentials", "请填写有效的邮箱和密码", 400);
      }
      const { data, error } = await context.client.auth.signInWithPassword({ email: email.trim(), password });
      if (error || !principalFromSupabaseUser(data.user)) {
        const status = error?.status === 429 ? 429 : (error && (!error.status || error.status >= 500) ? 503 : 401);
        return context.applyCookies(secureJson(request, { error: { code: "signin_failed", message: status === 429 ? "尝试过于频繁，请稍后重试" : status === 503 ? "登录服务暂时不可用" : "邮箱、密码不正确或账号尚未验证" } }, status));
      }
      return context.applyCookies(secureJson(request, { location: "/ledger" }, 200));
    }
    const { error } = await context.client.auth.signOut({ scope: "local" });
    if (error) throw new AuthenticationError("auth_mode_unavailable", "退出未完成，请重试");
    return context.applyCookies(secureJson(request, { location: safeAuthReturnTo(new URL(request.url).searchParams.get("return_to")) }, 200));
  } catch (error) {
    if (error instanceof RequestSecurityError) return secureJson(request, { error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof AuthenticationError) return secureJson(request, { error: { code: error.code, message: error.message } }, 503);
    if (error instanceof SyntaxError) return secureJson(request, { error: { code: "invalid_json", message: "请求格式错误" } }, 400);
    return secureJson(request, { error: { code: "auth_unavailable", message: "登录服务暂时不可用，请稍后重试" } }, 503);
  }
}
