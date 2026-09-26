import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("project provider routes and every scorer path enforce credentials and tenant isolation", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["run", "tests/helpers/model-providers-integration.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "isolated-provider-test-secret-1234567890",
          DATOOL_PROVIDER_ENCRYPTION_KEY: "",
          OPENAI_API_KEY: "",
          OPENAI_BASE_URL: "",
          DATOOL_API_KEY: "",
          DATOOL_PROJECT_ID: "",
        },
        timeout: 45000,
      }
    )
    expect(result.stdout).toContain("PASS provider permissions")
  } finally {
    await target.close()
  }
}, 60000)
