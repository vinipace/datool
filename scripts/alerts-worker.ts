import { closeAlertEvaluator } from "../src/server/alerts/evaluator"
import { db } from "../lib/db"
import { startAlertWorker } from "../src/server/alerts/worker"

const stop = startAlertWorker()
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await stop()
  await closeAlertEvaluator()
  await db.end()
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
console.info("Datool alert worker started")
