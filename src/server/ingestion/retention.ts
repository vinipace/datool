import { createIngestionQueue, type redisConnection } from "./queue"
import { describeIngestionError, diagnosticSummary, ingestionRelease } from "./diagnostics"

export const completedIngestionRetentionMs = 24 * 60 * 60 * 1000

/** Completed events already have durable PostgreSQL receipts. Never clean
 * waiting, delayed, active, or failed jobs: those may be the only event copy. */
export function cleanCompletedIngestionJobs(queue: ReturnType<typeof createIngestionQueue>) {
  return queue.clean(completedIngestionRetentionMs, 1000, "completed")
}

/** BullMQ's removeOnComplete is lazy. Sweep even when no new job succeeds. */
export function startCompletedIngestionCleanup(connection: ReturnType<typeof redisConnection>) {
  const queue = createIngestionQueue(connection)
  const reportError = (error: unknown) => {
    const diagnostic = describeIngestionError(error, "cleanup")
    console.error(JSON.stringify({ event: "ingestion_cleanup_error", severity: "ERROR", reason: diagnostic.code,
      release: ingestionRelease(), summary: diagnosticSummary(diagnostic), diagnostic }))
  }
  queue.on("error", reportError)
  let running: Promise<void> | undefined
  const tick = () => {
    if (running) return
    running = cleanCompletedIngestionJobs(queue)
      .then(ids => {
        if (ids.length) console.info(JSON.stringify({ event: "ingestion_completed_cleaned", count: ids.length }))
      })
      .catch(reportError)
      .finally(() => { running = undefined })
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  tick()
  return async () => {
    clearInterval(timer)
    await running
    await queue.close()
  }
}
