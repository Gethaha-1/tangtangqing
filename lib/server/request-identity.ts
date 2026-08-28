import { AuthenticationError, getTrustedPrincipal, resolveAuthMode, type Principal } from "./auth";
import { serverAuthOptions } from "./auth-runtime";
import { createSupabaseContext, verifiedSupabasePrincipal, type SupabaseContext } from "./supabase-auth";

const sessions = new WeakMap<Request, SupabaseContext>();

/** Supabase API routes authenticate independently, even if middleware is bypassed. */
export async function requestIdentity(request: Request): Promise<Principal> {
  const options = serverAuthOptions();
  if (resolveAuthMode(options.authMode) !== "supabase") return getTrustedPrincipal(request, options);
  const context = createSupabaseContext(request);
  sessions.set(request, context);
  const identity = await verifiedSupabasePrincipal(context);
  if (!identity) throw new AuthenticationError();
  return identity;
}

export function withRequestSession(request: Request, response: Response): Response {
  return sessions.get(request)?.applyCookies(response) ?? response;
}
