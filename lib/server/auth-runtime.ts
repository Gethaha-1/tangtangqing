import type { PrincipalOptions } from "./auth";

/**
 * Trusted deployment configuration. Never derive these values from Request.
 *
 * Read from the trusted Node process environment supplied by Netlify Functions
 * or the isolated local development launcher.
 */
export function serverAuthOptions(): PrincipalOptions {
  return {
    authMode: process.env.TTQ_AUTH_MODE,
    nodeEnv: process.env.NODE_ENV,
    internalSecret: process.env.TTQ_INTERNAL_AUTH_SECRET,
  };
}
