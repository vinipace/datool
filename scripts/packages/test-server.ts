/** Test-only loopback host for real authenticated API handlers and the worker. */
import { serveWebhook } from "../../src/server/apps/webhook"
import * as ingest from "../../app/api/ingest/route"
import * as traces from "../../app/api/traces/route"
import * as trace from "../../app/api/traces/[id]/route"
import * as spans from "../../app/api/traces/[id]/spans/route"
import * as apps from "../../app/api/apps/route"
import * as config from "../../app/api/apps/config/route"
import * as call from "../../app/api/apps/[id]/call/route"
import * as bridges from "../../app/api/apps/bridges/route"
import * as resources from "../../app/api/resources/route"
import { startIngestionWorker } from "../../src/server/ingestion/worker"
import {
  getIngestionQueue,
  redisConnection,
} from "../../src/server/ingestion/queue"
import { db, analyticsDb } from "../../lib/db"

if (process.env.DATOOL_PACKAGE_TEST !== "1")
  throw new Error("Run through test-packages-integration.ts")
for (const value of [process.env.DATABASE_URL, process.env.REDIS_URL]) {
  if (!value || new URL(value).hostname !== "127.0.0.1")
    throw new Error("Package tests require disposable loopback services")
}
const connection = redisConnection(true)
const worker = startIngestionWorker({ connection })
worker.on("error", () => {})
const server = await serveWebhook(async (request) => {
  const path = new URL(request.url).pathname
  const post = request.method === "POST"
  if (path === "/health") return Response.json({ ok: true })
  if (path === "/api/ingest")
    return post ? ingest.POST(request) : ingest.GET(request)
  if (path === "/api/traces") return traces.GET(request)
  if (path === "/api/apps") return post ? apps.POST(request) : apps.GET(request)
  if (path === "/api/apps/config")
    return post ? config.POST(request) : config.GET(request)
  if (path === "/api/apps/bridges") return bridges.POST(request)
  if (path === "/api/resources")
    return post ? resources.POST(request) : resources.GET(request)
  const traceMatch = path.match(/^\/api\/traces\/([^/]+)(\/spans)?$/)
  if (traceMatch) {
    const context = { params: Promise.resolve({ id: traceMatch[1] }) }
    return traceMatch[2]
      ? spans.GET(request, context)
      : trace.GET(request, context)
  }
  const callMatch = path.match(/^\/api\/apps\/([^/]+)\/call$/)
  if (callMatch)
    return call.POST(request, { params: Promise.resolve({ id: callMatch[1] }) })
  return new Response(null, { status: 404 })
})
console.info(`PACKAGE_SERVER=http://127.0.0.1:${server.port}`)
await new Promise<void>((resolve) => {
  process.once("SIGTERM", resolve)
  process.once("SIGINT", resolve)
})
server.stop()
await worker.close()
await getIngestionQueue().close()
await connection.quit()
await Promise.all([db.end(), analyticsDb.end()])
