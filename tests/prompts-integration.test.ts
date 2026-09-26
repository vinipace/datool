import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("managed prompt REST flow uses real project authorization and storage", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["run", "tests/helpers/prompts-integration.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          REDIS_URL: process.env.DATOOL_TEST_REDIS_URL ?? "",
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "isolated-prompt-test-secret-1234567890",
          DATOOL_API_KEY: "",
          DATOOL_PROJECT_ID: "",
        },
        timeout: 45000,
      }
    )
    expect(result.stdout).toContain("PASS prompt REST permissions")
  } finally {
    await target.close()
  }
}, 60000)
