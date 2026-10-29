import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

test("customer expiry removes inactive copies without losing active work, evidence or opt-outs", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--no-env-file", "tests/helpers/customer-retention.ts"],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: target.databaseUrl,
          TEST_PROJECT: target.projectId,
          TEST_ORGANIZATION: target.organizationId,
          DATOOL_BILLING_ENABLED: "true",
        },
      }
    )
    expect(stdout).toContain("PASS customer retention")
  } finally {
    await target.close()
  }
}, 60000)
