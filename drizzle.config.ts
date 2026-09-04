import { defineConfig } from "drizzle-kit";

// Local SQLite compatibility migrations only. Production PostgreSQL changes
// use reviewed SQL migrations under deploy/supabase/.
export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
