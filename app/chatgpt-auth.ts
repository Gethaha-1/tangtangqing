import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeAuthReturnTo } from "../lib/auth/logout";
import {
  AuthenticationError,
  getTrustedPrincipal,
  type PrincipalIssuer,
} from "../lib/server/auth";
import { serverAuthOptions } from "../lib/server/auth-runtime";

export type ChatGPTUser = {
  displayName: string;
  email: string | null;
  fullName: string | null;
  issuer: PrincipalIssuer;
  loginName: string | null;
};

const SIGN_IN_PATH = "/signin-with-chatgpt";

/**
 * Reads the identity asserted by the Sites dispatcher.
 *
 * This helper authenticates the request. Route handlers must still perform
 * server-side fleet membership and role checks before reading or writing data.
 */
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "app.local";
  const protocol = requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  try {
    const principal = getTrustedPrincipal(
      new Request(`${protocol}://${host}/`, { headers: requestHeaders }),
      serverAuthOptions(),
    );
    return {
      displayName: principal.displayName,
      email: principal.email,
      fullName: principal.displayName,
      issuer: principal.issuer,
      loginName: principal.loginName,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeAuthReturnTo(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}
