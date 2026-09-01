import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Netlify injects production variables into process.env. Local development uses
// a non-standard filename so @netlify/plugin-nextjs cannot auto-copy secrets
// into the generated server function.
if (existsSync(".ttq-local.env")) {
  loadEnvFile(".ttq-local.env");
}

await import("next/dist/bin/next");
