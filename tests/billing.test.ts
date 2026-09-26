import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("Cloud billing authorizes tenants, retries webhooks, and grants only verified subscriptions", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/billing-integration.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          BETTER_AUTH_SECRET:
            "billing-test-secret-at-least-thirty-two-characters",
          BETTER_AUTH_URL: "http://localhost:3000",
          DATOOL_BILLING_ENABLED: "true",
          STRIPE_SECRET_KEY: "sk_test_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fixture",
          STRIPE_CORE_PRICE_ID: "price_core",
          STRIPE_PRO_PRICE_ID: "price_pro",
          DATOOL_BILLING_TRIAL_DAYS: "0",
          GOOGLE_CLIENT_ID: "billing-fixture",
          GOOGLE_CLIENT_SECRET: "billing-fixture-secret",
          AUTH_ALLOW_PUBLIC_SIGNUP: "true",
        },
      }
    )
    expect(stdout).toContain(
      "PASS billing authorization, checkout, webhook recovery, subscription access, and disabled mode"
    )
  } finally {
    await target.close()
  }
}, 120_000)
