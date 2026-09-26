import { serveWebhook } from "../src/server/apps/webhook"
/** Isolated test child: invoked by ingestion-http.test.ts with fixture-only credentials. */
import { POST, GET } from "../app/api/ingest/route"
import { DatoolSpanProcessor } from "../src/lib/tracer/otel"
import { createTracer } from "../src/lib/tracer/sdk"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { redisConnection, getIngestionQueue } from "../src/server/ingestion/queue"
import { db } from "../lib/db"
const connection = redisConnection(true)
const worker = startIngestionWorker({ connection })
worker.on("error", () => {})
const server = await serveWebhook(async request => {
  if (new URL(request.url).pathname !== "/api/ingest") return new Response(null, { status: 404 })
  return request.method === "POST" ? POST(request) : GET(request)
})
try {
  const baseUrl = `http://127.0.0.1:${server.port}`
  const rejected = await fetch(`${baseUrl}/api/ingest`, { method: "POST", headers: { "x-project-id": process.env.DATOOL_PROJECT_ID!, authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" })
  if (rejected.status !== 401) throw new Error(`Wrong key was not rejected: ${rejected.status}`)
  const processor = new DatoolSpanProcessor({ baseUrl })
  const span = { name: "HTTP production canary", attributes: { input: "test" }, startTime: [1788912000, 0] as [number, number], endTime: [1788912001, 0] as [number, number], status: { code: 1 }, spanContext: () => ({ traceId: "http-canary", spanId: "http-span" }) }
  processor.onStart(span)
  processor.onEnd(span)
  await processor.forceFlush()
  const saved = await db.query("select status from traces where project_id = $1 and id = 'http-canary'", [process.env.DATOOL_PROJECT_ID])
  if (saved.rows[0]?.status !== "completed") throw new Error("OTel flush returned before persistence")
  const manual = createTracer({ baseUrl })
  await manual.trace({ name: "Manual HTTP canary" }, async () => ({ saved: true }))
  const count = await db.query("select count(*)::integer as count from traces where project_id = $1 and status = 'completed'", [process.env.DATOOL_PROJECT_ID])
  if (count.rows[0].count !== 2) throw new Error("Manual trace was not saved")
  console.info("Authenticated HTTP -> Redis -> PostgreSQL: OTel and manual SDK passed")
} finally {
  server.stop()
  await worker.close()
  await getIngestionQueue().close()
  await getIngestionQueue().disconnect()
  await connection.quit()
  await db.end()
}
