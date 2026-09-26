import { test, expect } from "bun:test"
import { spawn } from "node:child_process"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("organization keys and MCP OAuth enforce real PostgreSQL authorization boundaries", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["run", "tests/helpers/auth-integration.ts"],
        {
          env: {
            ...process.env,
            DATABASE_URL: target.databaseUrl,
            BETTER_AUTH_URL: "http://localhost:3000",
            BETTER_AUTH_SECRET:
              "isolated-test-secret-for-auth-integration-only-123",
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
    expect(output).toContain("PASS organization key")
    expect(output).toContain("PASS organization key database outage returns retryable HTTP 503")
    expect(output).toContain("PASS OAuth")
  } finally {
    await target.close()
  }
})
