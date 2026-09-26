import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/tracer/schema.ts",
  // Authoritative migrations are `migrations/*.sql`; keep any exploratory
  // Drizzle output separate from the authoritative SQL baseline.
  out: "./drizzle-pg",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost/datool",
  },
})
