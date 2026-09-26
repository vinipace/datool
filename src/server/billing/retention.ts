import { db } from "@/lib/db"
import {
  createIngestionQueue,
  redisConnection,
} from "@/src/server/ingestion/queue"
import { billingEnabled } from "./config"

/** Bounded cleanup, shared by all workers. Curated evidence is deliberately
 * pinned: evaluations, reviews and dataset source traces survive this policy. */
export async function expireCloudTraces(batchSize = 500) {
  if (!billingEnabled()) return 0
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Retention batches must contain 1–1000 traces.")
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL statement_timeout='15s'")
    await client.query("SET LOCAL lock_timeout='2s'")
    const result = await client.query(
      `
      WITH expired AS (
        SELECT t.id,t.project_id FROM traces t
        JOIN project p ON p.id=t.project_id
        JOIN organization_billing b ON b.organization_id=p.organization_id
        WHERE b.customer_id IS NOT NULL
          AND t.stored_at < now() - make_interval(days => b.retention_days)
          AND NOT EXISTS (SELECT 1 FROM eval_run_targets e WHERE e.project_id=t.project_id AND e.trace_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.project_id=t.project_id AND r.trace_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM dataset_items d WHERE d.project_id=t.project_id AND d.source_trace_id=t.id)
        ORDER BY t.stored_at,t.id LIMIT $1 FOR UPDATE OF t SKIP LOCKED
      ), records AS (
        SELECT id,project_id FROM expired
        UNION ALL SELECT s.id,s.project_id FROM spans s JOIN expired e ON e.id=s.trace_id
        UNION ALL SELECT s.id,s.project_id FROM scores s JOIN expired e ON e.id=s.trace_id
      ), receipts AS (
        UPDATE ingestion_receipts r
        SET result_json=jsonb_build_object('id',r.result_json->>'id','expired',true)
        FROM records d WHERE r.project_id=d.project_id AND r.result_json->>'id'=d.id
      ), imports AS (
        UPDATE langfuse_import_records r SET raw='{}'::jsonb,reason='DATA_RETENTION_EXPIRED'
        FROM records d WHERE r.project_id=d.project_id AND r.destination_id=d.id
      ), entities AS (
        UPDATE langfuse_import_entities r SET raw='{}'::jsonb
        FROM records d WHERE r.project_id=d.project_id AND r.id=d.id
      ) DELETE FROM traces WHERE id IN (SELECT id FROM expired)`,
      [batchSize]
    )
    await client.query("COMMIT")
    return result.rowCount ?? 0
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export function startCloudRetentionWorker() {
  if (!billingEnabled()) return async () => {}
  const connection = redisConnection()
  const queue = createIngestionQueue(connection)
  let running: Promise<void> | undefined
  const tick = () => {
    if (running) return
    running = (async () => {
      // BullMQ's age policy only runs when more jobs finish. Sweep quiet queues
      // too, so payload copies cannot outlive the shortest trace retention.
      try {
        await queue.clean(24 * 60 * 60 * 1000, 1000, "completed")
        await queue.clean(32 * 24 * 60 * 60 * 1000, 1000, "failed")
      } catch {
        console.error("Cloud queue retention failed; retrying next sweep.")
      }
      let deleted = 0
      // Cap each sweep; the next sweep resumes the remaining backlog.
      for (let batch = 0; batch < 20; batch++) {
        const count = await expireCloudTraces()
        deleted += count
        if (count < 500) break
      }
      if (deleted)
        console.info(JSON.stringify({ event: "cloud_retention", deleted }))
    })()
      .catch(() =>
        console.error("Cloud retention sweep failed; retrying next sweep.")
      )
      .finally(() => {
        running = undefined
      })
  }
  const timer = setInterval(tick, 60 * 60 * 1000)
  timer.unref()
  tick()
  return async () => {
    clearInterval(timer)
    await running
    await queue.close()
    await connection.quit()
  }
}
