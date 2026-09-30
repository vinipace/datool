import { Worker } from "bullmq"
import { createTracerDatabase, type TracerDatabase } from "../tracer/db"
import { TracerError } from "../tracer/errors"
import { parseIngestionEvent } from "./events"
import { persistEvent } from "./persist"
import { queueName, redisConnection, type IngestionJob } from "./queue"
import { IngestionPersistenceError, IngestionRejectedError, type IngestionStage } from "./diagnostics"

export function startIngestionWorker(options: { connection?: ReturnType<typeof redisConnection>; database?: (projectId: string) => TracerDatabase } = {}) {
  const databases = new Map<string, TracerDatabase>()
  const database = options.database ?? ((projectId: string) => {
    let db = databases.get(projectId)
    if (!db) { db = createTracerDatabase(undefined, { projectId }); databases.set(projectId, db) }
    return db
  })
  return new Worker<IngestionJob>(queueName, async job => {
    // Apply to jobs accepted by older API versions too. Repeating a stack on
    // every retry can exhaust Redis and prevent both ingestion and recovery.
    job.opts.stackTraceLimit = 1
    let stage: IngestionStage = "validate_event"
    try {
      const event = parseIngestionEvent(job.data.event)
      stage = "database"
      return await persistEvent(database(job.data.projectId), event, next => { stage = next })
    } catch (error) {
      if (error instanceof TracerError && [400, 401, 402, 403, 409, 413, 429].includes(error.status)) {
        throw new IngestionRejectedError(error, stage)
      }
      // Never persist driver errors or payloads in Redis job stack traces.
      throw new IngestionPersistenceError(error, stage)
    }
  }, { connection: options.connection ?? redisConnection(true), concurrency: 1,
    // A dead process must not hold accepted events for the SDK's entire flush window.
    // Keep the 30s renewable lock for slow database writes; inspect expired locks every 5s.
    stalledInterval: 5000,
  })
}
