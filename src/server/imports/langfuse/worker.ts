import { Queue, Worker, UnrecoverableError, DelayedError } from "bullmq"
import { redisConnection } from "../../ingestion/queue"
import { createTracerDatabase, type TracerDatabase } from "../../tracer/db"
import {
  credentialsFromEnvironment,
  LangfuseClient,
  SourceError,
  type Credentials,
} from "./client"
import { runImport } from "./runner"

export const importQueueName = "datool-langfuse-imports"
export type ImportJob = { projectId: string; runId: string }
export function createImportQueue(connection = redisConnection()) {
  return new Queue<ImportJob>(importQueueName, {
    connection,
    defaultJobOptions: {
      attempts: 12,
      backoff: { type: "fixed", delay: 60000 },
      removeOnComplete: { age: 86400, count: 100 },
      removeOnFail: false,
    },
  })
}
export async function enqueueImport(
  queue: ReturnType<typeof createImportQueue>,
  job: ImportJob
) {
  const existing = await queue.getJob(job.runId)
  if (existing) {
    const state = await existing.getState()
    if (state === "failed" || state === "completed") await existing.retry(state)
    return existing.id
  }
  return (await queue.add("import", job, { jobId: job.runId })).id
}
export function startImportWorker(
  options: {
    connection?: ReturnType<typeof redisConnection>
    database?: (projectId: string) => TracerDatabase
    credentials?: () => Credentials
    signal?: AbortSignal
  } = {}
) {
  const databases = new Map<string, TracerDatabase>()
  const database =
    options.database ??
    ((projectId: string) => {
      let db = databases.get(projectId)
      if (!db) {
        db = createTracerDatabase(undefined, { projectId })
        databases.set(projectId, db)
      }
      return db
    })
  return new Worker<ImportJob>(
    importQueueName,
    async (job) => {
      try {
        const credentials = (
          options.credentials ?? credentialsFromEnvironment
        )()
        return await runImport(
          database(job.data.projectId),
          job.data.runId,
          new LangfuseClient(credentials),
          { signal: options.signal }
        )
      } catch (error) {
        if (
          error instanceof SourceError &&
          error.retryAfterMs > 0 &&
          job.token
        ) {
          await job.moveToDelayed(Date.now() + error.retryAfterMs, job.token)
          throw new DelayedError()
        }
        const code =
          error instanceof SourceError ? error.code : "IMPORT_WORKER_ERROR"
        if (error instanceof SourceError && !error.retryable)
          throw new UnrecoverableError(code)
        // Never put response bodies, connection strings or source payloads into Redis errors.
        throw new Error(code)
      }
    },
    {
      connection: options.connection ?? redisConnection(true),
      concurrency: 1,
      stalledInterval: 5000,
    }
  )
}
