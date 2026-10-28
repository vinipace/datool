import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"

test("anonymous Inbox diagnostics persist only to the configured project, with bounded admission and idempotent receipts", async () => {
  const redis = process.env.DATOOL_TEST_REDIS_URL
  if (!redis || !["localhost", "127.0.0.1"].includes(new URL(redis).hostname) || redis === process.env.REDIS_URL) throw Error("Set a separate loopback DATOOL_TEST_REDIS_URL")
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-env-file", "tests/helpers/inbox-diagnostics-http.ts"], {
        env: { ...process.env, DATABASE_URL: target.databaseUrl, REDIS_URL: redis, INBOX_DIAGNOSTICS_PROJECT_ID: target.projectId, DATOOL_BILLING_ENABLED: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      child.stdout.on("data", chunk => { output += chunk })
      child.stderr.on("data", chunk => { output += chunk })
      child.once("error", reject)
      child.once("exit", code => resolve({ code, output }))
    })
    assert.equal(result.code, 0, result.output)
    expect(result.output).toContain("PASS Inbox diagnostic HTTP boundary")
  } finally { await target.close() }
}, 60_000)
