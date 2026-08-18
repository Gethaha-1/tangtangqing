import { env } from "cloudflare:workers";
import type { PrincipalOptions } from "./auth";

/** Trusted deployment configuration. Never derive these values from Request. */
export function serverAuthOptions(): PrincipalOptions {
  return {
    authMode: env.TTQ_AUTH_MODE,
    nodeEnv: env.NODE_ENV,
    internalSecret: env.TTQ_INTERNAL_AUTH_SECRET,
  };
}
