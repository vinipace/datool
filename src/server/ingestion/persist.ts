import { sql } from "drizzle-orm"
import { type TracerDatabase, getTracerProjectId, scopedTracerTransaction } from "../tracer/db"
import { TracerService } from "../tracer/service"
import { runTracerEffect } from "../tracer/effect"
import { TracerError } from "../tracer/errors"
import { applyEvent, eventDigest, type IngestionEvent } from "./events"
import { IngestionDependencyPendingError, type IngestionStage } from "./diagnostics"
import { postgresJson } from "./unicode"

export async function persistEvent(database: TracerDatabase, event: IngestionEvent, onStage: (stage: IngestionStage) => void = () => {}): Promise<unknown> {
  const projectId = getTracerProjectId(database)
  const digest = eventDigest(event)
  onStage("begin_transaction")
  return database.transaction(async tx => {
    // Serialize duplicate deliveries, including a worker whose Redis lease expired.
    onStage("lock_event")
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${projectId + ':' + event.id}, 0))`)
    onStage("read_receipt")
    const existing = await tx.execute<{ digest: string; result_json: unknown }>(sql`select digest, result_json from ingestion_receipts where project_id = ${projectId} and event_id = ${event.id}::uuid`)
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new TracerError("CONFLICT", "Event ID was reused with a different payload.")
      onStage("commit_transaction")
      return existing.rows[0].result_json
    }
    if (event.previousId) {
      onStage("check_dependency")
      const previous = await tx.execute(sql`select 1 from ingestion_receipts where project_id = ${projectId} and event_id = ${event.previousId}::uuid`)
      if (!previous.rowCount) throw new IngestionDependencyPendingError()
    }
    // Keep the original event/digest for retry identity; normalize only the
    // stored representation so a truncated UTF-16 value cannot poison a chain.
    onStage("apply_event")
    const storedEvent = { ...event, body: postgresJson(event.body) }
    const result = await runTracerEffect<unknown>(applyEvent(new TracerService(scopedTracerTransaction(database, tx)), storedEvent))
    onStage("save_receipt")
    await tx.execute(sql`insert into ingestion_receipts (project_id, event_id, digest, result_json) values (${projectId}, ${event.id}::uuid, ${digest}, ${JSON.stringify(result)}::jsonb)`)
    onStage("commit_transaction")
    return result
  })
}
