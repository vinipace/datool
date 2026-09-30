import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { createTracerDatabase } from "../tracer/db"
import {
  describeIngestionError,
  diagnosticSummary,
  ingestionContext,
  isRecordLimitFailure,
  readRetainedDiagnostic,
} from "./diagnostics"
import { jobIdFor, type createIngestionQueue } from "./queue"

/** One job, at most one predecessor and two existence checks; never replay or print event bodies. */
export async function inspectIngestionJob(
  queue: ReturnType<typeof createIngestionQueue>,
  id: string
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new Error("A single valid ingestion job ID is required")
  const job = await queue.getJob(id)
  if (!job) throw new Error("Ingestion job not found")
  const diagnostic = readRetainedDiagnostic(job.failedReason)
  const context = ingestionContext(job)
  const event = job.data.event
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const validIds =
    uuid.test(job.data.projectId) &&
    uuid.test(event?.id ?? "") &&
    (event?.previousId === null || uuid.test(event?.previousId ?? ""))
  let receipts: {
    eventSaved: boolean
    predecessorSaved: boolean | null
  } | null = null
  let receiptError = null
  let predecessor: { jobId: string; state: string } | null = null
  if (validIds) {
    if (event.previousId) {
      const previousId = jobIdFor(job.data.projectId, event.previousId)
      const previous = await queue.getJob(previousId)
      predecessor = {
        jobId: previousId,
        state: previous ? await previous.getState() : "absent",
      }
    }
    try {
      const database = createTracerDatabase(undefined, {
        projectId: job.data.projectId,
      })
      const result = await database.transaction(
        async (tx) => {
          await tx.execute(sql`set local statement_timeout = '5s'`)
          return tx.execute<{
            event_saved: boolean
            predecessor_saved: boolean
          }>(sql`
          select exists(select 1 from ingestion_receipts where project_id=${job.data.projectId} and event_id=${event.id}::uuid) as event_saved,
            exists(select 1 from ingestion_receipts where project_id=${job.data.projectId} and event_id=${event.previousId}::uuid) as predecessor_saved`)
        },
        { accessMode: "read only" }
      )
      receipts = {
        eventSaved: result.rows[0].event_saved,
        predecessorSaved: event.previousId
          ? result.rows[0].predecessor_saved
          : null,
      }
    } catch (error) {
      receiptError = describeIngestionError(error, "read_receipt")
    }
  }
  return {
    ...context,
    state: await job.getState(),
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    diagnostic,
    summary: diagnostic
      ? diagnosticSummary(diagnostic)
      : !job.failedReason
        ? "No retained failure."
        : isRecordLimitFailure(job.failedReason)
          ? "The project's monthly record limit was reached."
          : "Legacy job: structured diagnostics were not retained. Original failure text is withheld because it may contain customer data.",
    legacyFailureFingerprint:
      !diagnostic && job.failedReason
        ? createHash("sha256").update(job.failedReason).digest("hex")
        : null,
    receipts,
    receiptError,
    receiptStatus: !validIds
      ? "invalid_identifiers"
      : receiptError
        ? "unavailable"
        : "checked",
    predecessor,
  }
}
