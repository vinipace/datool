import { createIngestionQueue, redisConnection } from "../src/server/ingestion/queue"
import { readIngestionHealth } from "../src/server/ingestion/health"
import { compactFailedIngestionStacks } from "../src/server/ingestion/recovery"
import { cleanCompletedIngestionJobs } from "../src/server/ingestion/retention"
import { inspectIngestionJob } from "../src/server/ingestion/inspect"
import { db, analyticsDb } from "../lib/db"
const [action, id, extra] = process.argv.slice(2)
const connection = redisConnection()
const queue = createIngestionQueue(connection, { skipMetasUpdate: !action || ["status", "health", "inspect"].includes(action) })
try {
  await queue.waitUntilReady()
  if (extra) throw new Error("Unexpected ingestion command argument")
  if (action === "inspect" && id) {
    console.info(JSON.stringify(await inspectIngestionJob(queue, id)))
  } else if (action === "health") {
    const health = await readIngestionHealth(queue, connection)
    console.info(JSON.stringify(health))
    if (health.severity === "CRITICAL") process.exitCode = 2
  } else if (action === "compact-stacks") {
    let cursor = "0", compacted = 0, bytesRemoved = 0
    do {
      const result = await compactFailedIngestionStacks(queue, connection, cursor)
      cursor = result.cursor; compacted += result.compacted; bytesRemoved += result.bytesRemoved
    } while (cursor !== "0")
    console.info(JSON.stringify({ compacted, bytesRemoved }))
  } else if (action === "clean-completed") {
    console.info(JSON.stringify({ removed: (await cleanCompletedIngestionJobs(queue)).length }))
  } else if (action === "retry" && id) {
    const job = await queue.getJob(id)
    if (!job || await job.getState() !== "failed") throw new Error("A retained failed job ID is required")
    await job.retry("failed")
    console.info(`Requeued ${id}`)
  } else if (action === "status" || !action) {
    console.info(JSON.stringify(await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed")))
    for (const job of await queue.getJobs(["failed"], 0, 99)) console.info(JSON.stringify({ id: job.id, attempts: job.attemptsMade, timestamp: job.timestamp }))
  } else throw new Error("Usage: bun run ingestion:jobs [status | inspect JOB_ID | health | compact-stacks | clean-completed | retry JOB_ID]")
} finally { await queue.close(); await connection.quit(); await db.end(); if (analyticsDb !== db) await analyticsDb.end() }
