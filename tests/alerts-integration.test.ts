import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createTestAlertReader } from "./helpers/alert-reader"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("alerts: persistence, authorization, ingestion, matching, cooldown, concurrent workers and webhook retries", async () => {
  const target = await createIsolatedPostgres()
  let reader: Awaited<ReturnType<typeof createTestAlertReader>> | undefined
  try {
    await migrateIsolatedPostgres(target)
    reader = await createTestAlertReader(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["run", "tests/helpers/alerts-integration.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          DATOOL_ALERT_DATABASE_URL: reader.databaseUrl,
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET:
            "isolated-alert-test-secret-at-least-32-characters",
          DATOOL_ALERT_LOCAL_WEBHOOKS: "1",
        },
        timeout: 60000,
      }
    )
    expect(result.stdout).toContain("PASS alerts end-to-end integration")
  } finally {
    await target.close()
    await reader?.close()
  }
}, 90000)
