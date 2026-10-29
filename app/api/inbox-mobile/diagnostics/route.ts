import { z } from "zod"
import { db } from "@/lib/db"
import { diagnosticCodes, diagnosticStages } from "@/src/lib/inbox/diagnostics"
import { readJson, apiError } from "@/src/server/tracer/http"
import { TracerError } from "@/src/server/tracer/errors"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { persistEvent } from "@/src/server/ingestion/persist"
import { diagnosticRedis } from "@/src/server/inbox/diagnostic-redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const version = z.string().regex(/^(?:unknown|\d{1,9}(?:\.\d{1,9}){0,3})$/)
const reportSchema = z.object({
  id: z.string().uuid(), occurredAt: z.iso.datetime(),
  stage: z.enum(diagnosticStages), code: z.enum(diagnosticCodes),
  platform: z.enum(["ios", "android", "web"]),
  appVersion: version, buildVersion: version, online: z.boolean(),
  httpStatus: z.number().int().min(400).max(599).optional(),
}).strict()

// Public because login itself can fail. Global, atomic caps bound writes even
// when a sender rotates IPs/IDs. This is diagnostic evidence, not trusted audit.
const admission = `
  for i = 1, #KEYS do
    local count = tonumber(redis.call('GET', KEYS[i]) or '0')
    if count >= tonumber(ARGV[i * 2 - 1]) then return redis.call('TTL', KEYS[i]) end
  end
  for i = 1, #KEYS do
    if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
  end
  return 0
`

export async function POST(request: Request) {
  try {
    // Never accept a project/key/identity supplied by an unauthenticated client.
    const projectId = process.env.INBOX_DIAGNOSTICS_PROJECT_ID?.trim()
    if (!projectId) return Response.json({ error: { code: "DIAGNOSTICS_DISABLED" } }, { status: 503, headers: { "Cache-Control": "no-store" } })
    const parsed = reportSchema.safeParse(await readJson(request, 4096))
    if (!parsed.success) throw new TracerError("VALIDATION_ERROR", "Invalid diagnostic report.")
    const report = parsed.data
    const age = Date.now() - Date.parse(report.occurredAt)
    if (age < -300_000 || age > 7 * 86400_000) throw new TracerError("VALIDATION_ERROR", "Diagnostic report expired.")
    const redis = await diagnosticRedis()
    const retryAfter = Number(await redis.eval(admission, 2,
      `inbox-diagnostics:${projectId}:minute`, `inbox-diagnostics:${projectId}:day`,
      60, 60, 1000, 86400))
    if (retryAfter !== 0) return Response.json({ error: { code: "RATE_LIMITED" } }, {
      status: 429, headers: { "Retry-After": String(Math.max(1, retryAfter)), "Cache-Control": "no-store" },
    })
    const project = await db.query("select id from project where id=$1", [projectId])
    if (!project.rowCount) return Response.json({ error: { code: "DIAGNOSTICS_UNAVAILABLE" } }, { status: 503, headers: { "Cache-Control": "no-store" } })
    const traceId = `inbox-error-${report.id}`
    await persistEvent(createTracerDatabase(undefined, { projectId }), {
      id: report.id, previousId: null, path: "/api/traces", method: "POST",
      body: {
        id: traceId, name: `Inbox · ${report.stage}`, operation: "inbox.app_error", status: "errored",
        startedAt: report.occurredAt, endedAt: report.occurredAt,
        attributes: {
          "service.name": "datool-inbox", "diagnostic.source": "unverified-client",
          "diagnostic.id": report.id, "error.code": report.code, "error.stage": report.stage,
          "app.version": report.appVersion, "app.build": report.buildVersion,
          "os.platform": report.platform, "network.online": report.online,
          ...(report.httpStatus ? { "http.status_code": report.httpStatus } : {}),
        },
      },
    })
    // A successful receipt means PostgreSQL committed, not merely accepted a job.
    return Response.json({ data: { id: report.id, status: "saved" } }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof TracerError && error.status < 500) return apiError(error)
    // Do not echo database, Redis or provider errors to this public endpoint.
    return Response.json({ error: { code: "DIAGNOSTICS_UNAVAILABLE" } }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
