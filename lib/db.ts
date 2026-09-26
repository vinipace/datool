import { Pool } from "pg"
import { billingDatabaseUrl } from "./billing-database"

const missingDatabaseUrl =
  "postgresql://missing:missing@127.0.0.1:1/missing-database"

const globalForDatabase = globalThis as typeof globalThis & {
  datoolDatabasePool?: Pool
}

/**
 * The shared PostgreSQL pool. Creating a Pool does not open a connection, so
 * importing server modules remains safe during `next build`. Keeping it on
 * globalThis also prevents development hot reloads from creating extra pools.
 */
export const db =
  globalForDatabase.datoolDatabasePool ??
  new Pool({
    connectionString: billingDatabaseUrl(
      process.env.DATABASE_URL ?? missingDatabaseUrl
    ),
    connectionTimeoutMillis: 5000,
  })

// pg removes failed idle connections itself. Handle the notification so a
// database restart does not also crash the API/worker and strand Redis leases.
if (db.listenerCount("error") === 0) {
  db.on("error", () =>
    console.error("PostgreSQL idle connection lost; the pool will reconnect.")
  )
}

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.datoolDatabasePool = db
}

export function assertDatabaseConfiguration() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. Set it to the PostgreSQL connection string before handling requests."
    )
  }
}

/** Analytical snapshots have a separate ceiling so they cannot occupy the write pool. */
const analyticsGlobal = globalThis as typeof globalThis & {
  datoolAnalyticsPool?: Pool
}
export const analyticsDb = (analyticsGlobal.datoolAnalyticsPool ??= new Pool({
  connectionString: process.env.DATABASE_URL ?? missingDatabaseUrl,
  max: 6,
  connectionTimeoutMillis: 1000,
  statement_timeout: 10000,
}))
if (analyticsDb.listenerCount("error") === 0)
  analyticsDb.on("error", () =>
    console.error("Analytics database connection lost.")
  )
