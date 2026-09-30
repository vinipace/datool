import { NextResponse } from "next/server"
import {
  authorizeProject,
  assertTracerMutationOrigin,
  readJson,
  apiError,
} from "@/src/server/tracer/http"
import { parseIngestionEvent, eventDigest } from "@/src/server/ingestion/events"
import { getIngestionQueue, jobIdFor } from "@/src/server/ingestion/queue"
import { TracerError } from "@/src/server/tracer/errors"
import { db } from "@/lib/db"
import { assertIngestionCapacity } from "@/src/server/billing/usage"
import { describeIngestionError, diagnosticSummary, ingestionEventContext, ingestionRelease, isRecordLimitFailure } from "@/src/server/ingestion/diagnostics"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const { projectId, identity } = await authorizeProject(request)
    assertTracerMutationOrigin(request)
    const event = parseIngestionEvent(await readJson(request))
    await assertIngestionCapacity(identity.organizationId, projectId, event)
    try {
      const queue = getIngestionQueue()
      const id = jobIdFor(projectId, event.id)
      await queue.add("lifecycle", { projectId, event }, { jobId: id })
      const job = await queue.getJob(id)
      if (!job || eventDigest(job.data.event) !== eventDigest(event)) {
        throw new TracerError(
          "CONFLICT",
          "Event ID was reused with a different payload."
        )
      }
      if (
        (await job.getState()) === "failed" &&
        isRecordLimitFailure(job.failedReason)
      )
        await job.retry()
      return NextResponse.json(
        { data: { eventId: event.id, status: "queued" } },
        { status: 202 }
      )
    } catch (error) {
      if (error instanceof TracerError) throw error
      const diagnostic = describeIngestionError(error, "enqueue")
      console.error(JSON.stringify({ event: "ingestion_queue_error", severity: "ERROR", jobId: jobIdFor(projectId, event.id), ...ingestionEventContext(projectId, event),
        release: ingestionRelease(), reason: diagnostic.code, summary: diagnosticSummary(diagnostic), diagnostic }))
      throw new TracerError(
        "INTERNAL_ERROR",
        "Trace queue unavailable; retry this event with the same ID.",
        { status: 503 }
      )
    }
  } catch (error) {
    return apiError(error)
  }
}
export async function GET(request: Request) {
  try {
    const { projectId } = await authorizeProject(request)
    const id = new URL(request.url).searchParams.get("eventId")
    if (!id || !/^[a-f0-9-]{36}$/i.test(id))
      throw new TracerError("VALIDATION_ERROR", "Valid eventId required.")
    const saved = await db.query(
      "select result_json from ingestion_receipts where project_id = $1 and event_id = $2::uuid",
      [projectId, id]
    )
    if (saved.rows[0])
      return NextResponse.json(
        { data: { status: "saved", result: saved.rows[0].result_json } },
        { headers: { "Cache-Control": "no-store" } }
      )
    const job = await getIngestionQueue().getJob(jobIdFor(projectId, id))
    if (!job)
      throw new TracerError("NOT_FOUND", "Ingestion event was not found.")
    return NextResponse.json(
      {
        data: {
          status: await job.getState(),
          attempts: job.attemptsMade,
          ...(isRecordLimitFailure(job.failedReason)
            ? { reason: "RECORD_LIMIT_REACHED", billingUrl: "/billing" }
            : {}),
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}
