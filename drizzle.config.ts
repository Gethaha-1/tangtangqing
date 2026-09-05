import { defineConfig } from "drizzle-kit";

// Local SQLite compatibility migrations only. Production PostgreSQL changes
// use the initial deploy/supabase schema plus supabase/migrations/ increments.
export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
});
