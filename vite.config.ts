import vinext from "vinext";
import { defineConfig } from "vite";
import { randomBytes } from "node:crypto";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const { d1, r2 } = hostingConfig;
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "tangtangqing-local",
          database_id: LOCAL_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [{ binding: r2, bucket_name: "tangtangqing-local-r2" }]
    : [],
};

export default defineConfig(async ({ command }) => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const developmentVars = command === "serve"
    ? {
        // The caller must still opt in with TTQ_AUTH_MODE=local. Vite does not
        // automatically forward shell variables into the Worker environment.
        TTQ_AUTH_MODE:
          process.env.TTQ_AUTH_MODE === "local" ? "local" : "",
        NODE_ENV: "development",
        // Per-process proof only; never persisted or reused for deployment.
        TTQ_INTERNAL_AUTH_SECRET: randomBytes(32).toString("hex"),
      }
    : undefined;

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: { ...localBindingConfig, vars: developmentVars },
      }),
    ],
  };
});
