import { createHash } from "node:crypto"
import { Queue, type QueueOptions } from "bullmq"
import { Redis } from "ioredis"
import type { IngestionEvent } from "./events"

export const queueName = "datool-ingestion"
export type IngestionJob = { projectId: string; event: IngestionEvent }
export function redisConnection(worker = false, url = process.env.REDIS_URL) {
  if (!url) throw new Error("REDIS_URL is required for trace ingestion")
  return new Redis(url, {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 5000,
    ...(worker ? {} : { commandTimeout: 5000 }),
  })
}
export const jobIdFor = (projectId: string, eventId: string) => createHash("sha256").update(`${projectId}\0${eventId}`).digest("hex")
export function createIngestionQueue(connection = redisConnection(), options: Pick<QueueOptions, "skipMetasUpdate"> = {}) {
  return new Queue<IngestionJob>(queueName, { ...options, connection,
    defaultJobOptions: { attempts: 120, backoff: { type: "fixed", delay: 5000 }, stackTraceLimit: 1, removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: false },
  })
}
let queue: ReturnType<typeof createIngestionQueue> | undefined
export function getIngestionQueue() { return queue ??= createIngestionQueue() }
