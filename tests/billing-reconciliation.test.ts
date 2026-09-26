import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("billing reconciliation recovers missed events, retries durably, and runs without browser traffic", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/billing-reconciliation.ts"],
      {
        cwd: process.cwd(),
        timeout: 100_000,
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          DATOOL_BILLING_ENABLED: "true",
          BETTER_AUTH_URL: "http://localhost:3000",
          STRIPE_SECRET_KEY: "sk_test_reconciliation_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fixture",
          STRIPE_CORE_PRICE_ID: "price_core",
          STRIPE_PRO_PRICE_ID: "price_pro",
          CMS_ADMIN_USER_IDS: "reconciliation-admin",
          SYSTEM_ADMIN_USER_IDS: "reconciliation-admin",
        },
      }
    )
    expect(stdout).toContain(
      "PASS missed events, durable retries, recovery logs, bounded batches, locking, disabled mode, startup, recurring sweep and shutdown"
    )
  } finally {
    await target.close()
  }
}, 120_000)
