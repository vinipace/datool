import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir } from "node:fs/promises"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"

if (process.env.DATOOL_LIVE_EXECUTION_CHECK !== "true")
  throw new Error(
    "Set DATOOL_LIVE_EXECUTION_CHECK=true to authorize bounded live provider calls (under US$0.03 at the checked-in rates)."
  )
const target = await createIsolatedPostgres()
try {
  await mkdir(".tmp", { recursive: true })
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const child = promisify(execFile)(
    "bun",
    ["--no-env-file", "tests/helpers/managed-execution-live.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: target.databaseUrl,
        TEST_ORGANIZATION_ID: target.organizationId,
        TEST_PROJECT_ID: target.projectId,
        BETTER_AUTH_SECRET: "live-test-only-secret-over-thirty-two-characters",
        DATOOL_BILLING_ENABLED: "true",
        DATOOL_MANAGED_EXECUTION_ENABLED: "true",
        STRIPE_SECRET_KEY: "sk_test_fixture",
        STRIPE_WEBHOOK_SECRET: "whsec_fixture",
        STRIPE_CORE_PRICE_ID: "price_core",
        STRIPE_PRO_PRICE_ID: "price_pro",
      },
      timeout: 240000,
    }
  )
  child.child.stdout?.pipe(process.stdout)
  child.child.stderr?.pipe(process.stderr)
  try {
    await child
  } catch {
    process.exitCode = 1
  }
} finally {
  await target.close()
}
