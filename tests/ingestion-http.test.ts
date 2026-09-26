import { test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"
test("authenticated HTTP ingestion saves OTel and manual traces before flush returns", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["run", "scripts/verify-ingestion-http.ts"], { env: { ...process.env, DATABASE_URL: target.databaseUrl, REDIS_URL: process.env.DATOOL_TEST_REDIS_URL, DATOOL_API_KEY: crypto.randomUUID(), DATOOL_PROJECT_ID: target.projectId, BETTER_AUTH_SECRET: "test-only-secret-with-at-least-thirty-two-characters", BETTER_AUTH_URL: "http://localhost:3000" }, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", value => { output += value })
      child.stderr.on("data", value => { output += value })
      child.on("error", reject)
      child.on("close", code => resolve({ code, output }))
    })
    if (result.code !== 0) throw new Error(result.output)
    expect(result.output.includes("OTel and manual SDK passed")).toBe(true)
  } finally { await target.close() }
})
