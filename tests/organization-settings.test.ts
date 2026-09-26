import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("organization details persist with role, tenant, validation, and origin checks", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["run", "tests/helpers/organization-settings-integration.ts"],
        {
          env: {
            ...process.env,
            // Better Auth skips origin checks under NODE_ENV=test.
            NODE_ENV: "development",
            DATABASE_URL: target.databaseUrl,
            BETTER_AUTH_URL: "http://localhost:3000",
            BETTER_AUTH_SECRET:
              "isolated-organization-settings-test-secret-1234567890",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      let output = ""
      child.stdout.on("data", (data) => {
        output += data
      })
      child.stderr.on("data", (data) => {
        output += data
      })
      child.on("error", reject)
      child.on("exit", (code) =>
        code === 0 ? resolve(output) : reject(new Error(output))
      )
    })
    expect(output).toContain(
      "PASS organization settings persistence, permissions, validation, and CSRF"
    )
  } finally {
    await target.close()
  }
}, 60000)
