import { test, expect } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

test("Shopify onboarding and billing preserve tenant and payment ownership across OAuth, retries and provider failures", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/shopify-billing.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          TEST_ORGANIZATION: target.organizationId,
          TEST_OWNER: target.ownerId,
          TEST_PROJECT: target.projectId,
          BETTER_AUTH_URL: "https://datool.example",
          BETTER_AUTH_SECRET:
            "shopify-billing-fixture-secret-at-least-thirty-two-characters",
          DATOOL_BILLING_ENABLED: "true",
          AUTH_ALLOW_PUBLIC_SIGNUP: "true",
          DATOOL_PROVIDER_ENCRYPTION_KEY:
            "fixture-key-not-for-production-at-least-32-characters",
          DATOOL_SHOPIFY_CLIENT_ID: "fixture-client",
          DATOOL_SHOPIFY_CLIENT_SECRET: "fixture-secret",
          DATOOL_SHOPIFY_APP_HANDLE: "datool",
          DATOOL_SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
          DATOOL_SHOPIFY_PARTNER_ACCESS_TOKEN: "fixture-partner-token",
          DATOOL_SHOPIFY_APP_ID: "456",
          STRIPE_SECRET_KEY: "sk_test_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fixture",
          STRIPE_CORE_PRICE_ID: "price_core",
          STRIPE_PRO_PRICE_ID: "price_pro",
        },
      }
    )
    expect(stdout).toContain("PASS Shopify billing lifecycle")
  } finally {
    await target.close()
  }
}, 120_000)
