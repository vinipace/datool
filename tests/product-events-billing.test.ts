import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("verified billing events notify once for paid activations and isolate Slack failures", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/product-events-billing.ts"],
      {
        cwd: process.cwd(),
        timeout: 90_000,
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          DATOOL_BILLING_ENABLED: "true",
          DATOOL_MANAGED_EXECUTION_ENABLED: "false",
          BETTER_AUTH_URL: "http://localhost:3000",
          STRIPE_SECRET_KEY: "sk_test_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fixture",
          STRIPE_CORE_PRICE_ID: "price_core",
          STRIPE_PRO_PRICE_ID: "price_pro",
          SLACK_BOT_TOKEN: "fixture-secret",
          SLACK_SUBSCRIPTIONS_CHANNEL: "CFIXTURE",
        },
      }
    )
    expect(stdout).toContain(
      "PASS paid activations, trial conversion, renewals, duplicate events, signatures and failure isolation"
    )
  } finally {
    await target.close()
  }
}, 120_000)
