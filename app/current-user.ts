import { headers } from "next/headers";
import {
  AuthenticationError,
  getTrustedPrincipal,
  type PrincipalIssuer,
} from "../lib/server/auth";
import { serverAuthOptions } from "../lib/server/auth-runtime";

export type CurrentUser = {
  displayName: string;
  email: string | null;
  issuer: PrincipalIssuer;
  loginName: string | null;
};

/** Reads the Principal already verified and minted by the server boundary. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
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
      issuer: principal.issuer,
      loginName: principal.loginName,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}
