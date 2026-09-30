import { closeAlertEvaluator } from "../src/server/alerts/evaluator"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { redisConnection } from "../src/server/ingestion/queue"
import { db } from "../lib/db"
import { startAlertWorker } from "../src/server/alerts/worker"
import { startCloudRetentionWorker } from "../src/server/billing/retention"
import { startBillingReconciliationWorker } from "../src/server/billing/reconciliation"
import { describeIngestionError, diagnosticSummary, ingestionContext, ingestionFailureLog, ingestionRelease } from "../src/server/ingestion/diagnostics"
import { startCompletedIngestionCleanup } from "../src/server/ingestion/retention"
import { startIngestionHealthMonitor } from "../src/server/ingestion/health"
const stopBillingReconciliation = startBillingReconciliationWorker()
const stopRetention = startCloudRetentionWorker()
const stopAlerts = startAlertWorker()
const connection = redisConnection(true)
const stopIngestionCleanup = startCompletedIngestionCleanup(connection)
const stopIngestionHealth = startIngestionHealthMonitor()
const worker = startIngestionWorker({ connection })
worker.on("error", error => {
  const diagnostic = describeIngestionError(error, "worker")
  console.error(JSON.stringify({ event: "ingestion_worker_error", severity: "ERROR", release: ingestionRelease(), reason: diagnostic.code, summary: diagnosticSummary(diagnostic), diagnostic }))
})
worker.on("failed", (job, error) => {
  // Report the first and final failure, not every intermediate retry. Queue
  // health still reports stalled persistence every minute during the outage.
  const record = ingestionFailureLog(job, error)
  if (record) console.error(JSON.stringify(record))
})
worker.on("completed", job => console.info(JSON.stringify({ event: "ingestion_saved", severity: "INFO", release: ingestionRelease(), ...ingestionContext(job) })))
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
