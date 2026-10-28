import assert from "node:assert/strict"
import { POST } from "../../app/api/inbox-mobile/diagnostics/route"
import { db, analyticsDb } from "../../lib/db"
import { diagnosticRedis } from "../../src/server/inbox/diagnostic-redis"

const projectId = process.env.INBOX_DIAGNOSTICS_PROJECT_ID!
const report = {
  id: crypto.randomUUID(), occurredAt: new Date().toISOString(), stage: "google_session", code: "SESSION_MISSING",
  platform: "ios", appVersion: "1.0.0", buildVersion: "11", online: true,
}
const send = (body: unknown, headers: Record<string, string> = {}) => POST(new Request("https://datool.example/api/inbox-mobile/diagnostics", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
}))
const redis = await diagnosticRedis()
const keys = [`inbox-diagnostics:${projectId}:minute`, `inbox-diagnostics:${projectId}:day`]
try {
  delete process.env.INBOX_DIAGNOSTICS_PROJECT_ID
  assert.equal((await send(report)).status, 503)
  process.env.INBOX_DIAGNOSTICS_PROJECT_ID = projectId
  for (const extra of [{ projectId: "foreign" }, { message: "cookie=SECRET" }, { stack: "SECRET" }, { code: "SECRET" }, { appVersion: "alice@example.test" }]) {
    assert.equal((await send({ ...report, ...extra })).status, 400)
  }
  assert.equal((await send({ ...report, occurredAt: "2000-01-01T00:00:00.000Z" })).status, 400)
  assert.equal((await send({ ...report, padding: "x".repeat(5000) })).status, 413)
  const first = await send(report, { "x-project-id": "foreign", cookie: "SECRET", authorization: "Bearer SECRET" })
  assert.equal(first.status, 200, await first.clone().text())
  assert.deepEqual((await first.json()).data, { id: report.id, status: "saved" })
  const duplicates = await Promise.all([send(report), send(report)])
  assert(duplicates.every(response => response.status === 200))
  assert.equal((await send({ ...report, code: "OAUTH_FAILED" })).status, 409)
  const records = await db.query("select id,project_id,status,attributes_json from traces")
  assert.equal(records.rowCount, 1)
  assert.equal(records.rows[0].project_id, projectId)
  assert.equal(records.rows[0].status, "errored")
  assert.equal(records.rows[0].id, `inbox-error-${report.id}`)
  assert.equal(records.rows[0].attributes_json["error.code"], "SESSION_MISSING")
  assert(!JSON.stringify(records.rows).includes("SECRET"))
  assert.equal((await db.query("select event_id from ingestion_receipts")).rowCount, 1)
  // Force each global budget, then exercise real atomic Redis admission.
  for (const [index, limit] of [60, 1000].entries()) {
    await redis.set(keys[index], String(limit), "EX", 60)
    const limited = await send({ ...report, id: crypto.randomUUID() })
    assert.equal(limited.status, 429)
    assert(Number(limited.headers.get("retry-after")) > 0)
    await redis.del(keys[index])
  }
  console.log("PASS Inbox diagnostic HTTP boundary: durable trace and receipt, replay, project isolation, privacy allowlist, size/age limits, global rate caps")
} finally {
  await redis.del(...keys)
  await redis.quit()
  await Promise.all([db.end(), analyticsDb.end()])
}
