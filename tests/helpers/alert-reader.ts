import { Pool } from "pg"
import {
  provisionAlertReader,
  quoteIdentifier,
} from "../../src/server/alerts/provision"
import type { IsolatedPostgres } from "./postgres"

/** The parent schema owns the view. Drop the schema before dropping this role. */
export async function createTestAlertReader(target: IsolatedPostgres) {
  const role = `alert_test_${crypto.randomUUID().replaceAll("-", "")}`
  const url = new URL(target.databaseUrl)
  url.username = role
  url.password = crypto.randomUUID()
  const admin = new Pool({ connectionString: target.databaseUrl })
  try {
    await provisionAlertReader(admin, url.toString())
  } finally {
    await admin.end()
  }
  return {
    databaseUrl: url.toString(),
    async close() {
      const admin = new Pool({ connectionString: target.databaseUrl })
      try {
        await admin.query(`DROP ROLE ${quoteIdentifier(role)}`)
      } finally {
        await admin.end()
      }
    },
  }
}
