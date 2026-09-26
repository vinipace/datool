import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("sandbox settings enforce permissions, encryption, defaults and project isolation", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["run", "tests/helpers/sandbox-providers-integration.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "isolated-sandbox-test-secret-1234567890",
          DATOOL_PROVIDER_ENCRYPTION_KEY: "",
          DATOOL_API_KEY: "",
          DATOOL_PROJECT_ID: "",
        },
        timeout: 90000,
      }
    )
    expect(result.stdout).toContain("PASS sandbox settings")
  } finally {
    await target.close()
  }
}, 120000)
