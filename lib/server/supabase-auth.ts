import { createServerClient, parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { AuthenticationError, type Principal } from "./auth.ts";

type CookieChange = { name: string; value: string; options: CookieOptions };
export type SupabaseContext = ReturnType<typeof createSupabaseContext>;

export function supabaseConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const url = env.TTQ_SUPABASE_URL;
  const key = env.TTQ_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new AuthenticationError("auth_mode_unavailable", "Supabase 项目尚未配置");
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local && env.NODE_ENV !== "production" && env.NETLIFY !== "true"))) {
    throw new AuthenticationError("auth_mode_unavailable", "Supabase 地址必须使用 HTTPS");
  }
  if (!key.startsWith("sb_publishable_")) {
    try {
      const payload = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.role !== "anon") throw new Error("not anon");
    } catch { throw new AuthenticationError("auth_mode_unavailable", "仅允许 Supabase publishable/anon key，禁止管理密钥"); }
  }
  return { url: parsed.toString().replace(/\/$/, ""), key };
}

export function createSupabaseContext(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  transport: typeof fetch = fetch,
) {
  const config = supabaseConfiguration(env);
  const jar = new Map(parseCookieHeader(request.headers.get("cookie") ?? "").map(({ name, value }) => [name, value ?? ""]));
  const changes = new Map<string, CookieChange>();
  const responseHeaders = new Headers();
  const client = createServerClient(config.url, config.key, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: new URL(request.url).protocol === "https:", path: "/" },
    cookies: {
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
      setAll(cookies, headers) {
        for (const cookie of cookies) {
          jar.set(cookie.name, cookie.value);
          changes.set(cookie.name, cookie);
        }
        for (const [name, value] of Object.entries(headers ?? {})) responseHeaders.set(name, value);
      },
    },
    global: {
      fetch: async (input, init) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) controller.abort();
        const timer = setTimeout(abort, 8_000);
        try { return await transport(input, { ...init, signal: controller.signal }); }
        finally { clearTimeout(timer); init?.signal?.removeEventListener("abort", abort); }
      },
    },
  });
  return {
    client,
    requestCookies: () => Array.from(jar, ([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
    applyCookies(response: Response): Response {
      const headers = new Headers(response.headers);
      for (const change of changes.values()) headers.append("set-cookie", serializeCookieHeader(change.name, change.value, change.options));
      responseHeaders.forEach((value, name) => headers.set(name, value));
      headers.set("cache-control", "private, no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}

export function principalFromSupabaseUser(user: User | null): Principal | null {
  if (!user || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) || !user.email_confirmed_at || user.is_anonymous) return null;
  const rawName: unknown = user.user_metadata?.display_name ?? user.user_metadata?.full_name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const displayName = name && name.length <= 70 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : "车主";
  return { issuer: "supabase", subject: user.id, displayName, email: user.email ?? null, loginName: user.email ?? null };
}

/** Never use getSession().user as proof; getUser asks the Auth server. */
export async function verifiedSupabasePrincipal(context: SupabaseContext): Promise<Principal | null> {
  const { data, error } = await context.client.auth.getUser();
  if (error) {
    if (error.name === "AuthSessionMissingError" || ["bad_jwt", "session_not_found", "user_not_found", "refresh_token_not_found"].includes(error.code ?? "") || error.status === 401 || error.status === 403) return null;
    throw new AuthenticationError("auth_mode_unavailable", "登录服务暂时不可用，请稍后重试");
  }
  return principalFromSupabaseUser(data.user);
}
