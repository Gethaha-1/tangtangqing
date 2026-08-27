import type { PrincipalOptions } from "./auth";

/**
 * Trusted deployment configuration. Never derive these values from Request.
 *
 * Previously sourced from Cloudflare's `env`; now read from the Node process
 * environment so the app runs as a standard Next.js server (CloudBase 云托管).
 */
export function serverAuthOptions(): PrincipalOptions {
  return {
    authMode: process.env.TTQ_AUTH_MODE,
    nodeEnv: process.env.NODE_ENV,
    internalSecret: process.env.TTQ_INTERNAL_AUTH_SECRET,
  };
}
