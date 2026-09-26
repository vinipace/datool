import { closeAlertEvaluator } from "../src/server/alerts/evaluator"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { redisConnection } from "../src/server/ingestion/queue"
import { db } from "../lib/db"
import { startAlertWorker } from "../src/server/alerts/worker"
import { startCloudRetentionWorker } from "../src/server/billing/retention"
import { startBillingReconciliationWorker } from "../src/server/billing/reconciliation"
import { ingestionFailureCode } from "../src/server/ingestion/diagnostics"
import { startCompletedIngestionCleanup } from "../src/server/ingestion/retention"
import { startIngestionHealthMonitor } from "../src/server/ingestion/health"
import { UnrecoverableError } from "bullmq"
const stopBillingReconciliation = startBillingReconciliationWorker()
const stopRetention = startCloudRetentionWorker()
const stopAlerts = startAlertWorker()
const connection = redisConnection(true)
const stopIngestionCleanup = startCompletedIngestionCleanup(connection)
const stopIngestionHealth = startIngestionHealthMonitor()
const worker = startIngestionWorker({ connection })
worker.on("error", error => console.error(JSON.stringify({ event: "ingestion_worker_error", reason: ingestionFailureCode(error) })))
worker.on("failed", (job, error) => {
  // Report the first and final failure, not every intermediate retry. Queue
  // health still reports stalled persistence every minute during the outage.
  if (!job || job.attemptsMade === 1 || job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError)
    console.error(JSON.stringify({ event: "ingestion_failed", jobId: job?.id, attemptsMade: job?.attemptsMade, reason: ingestionFailureCode(error) }))
})
worker.on("completed", job => console.info(JSON.stringify({ event: "ingestion_saved", jobId: job.id })))
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  const billingReconciliationStopped = stopBillingReconciliation()
  await worker.close()
  await stopIngestionCleanup()
  await stopIngestionHealth()
  await stopAlerts()
  await stopRetention()
  await billingReconciliationStopped
  await connection.quit()
  await closeAlertEvaluator()
  await db.end()
}
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
console.info("Datool ingestion worker started")
