import { Pool } from "pg"
import { provisionAlertReader } from "../src/server/alerts/provision"

const writer = process.env.DATABASE_URL
const reader = process.env.DATOOL_ALERT_DATABASE_URL
if (!writer || !reader)
  throw new Error(
    "Set DATABASE_URL (administrator) and DATOOL_ALERT_DATABASE_URL (new dedicated reader)."
  )
const source = new URL(writer)
const destination = new URL(reader)
if (
  source.host !== destination.host ||
  source.pathname !== destination.pathname ||
  source.search !== destination.search
)
  throw new Error(
    "Alert reader and administrator URLs must target the same server, database and connection options."
  )
const pool = new Pool({ connectionString: writer })
try {
  await provisionAlertReader(pool, reader)
  console.info("Restricted alert reader provisioned.")
} finally {
  await pool.end()
}
