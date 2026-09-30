import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { createIngestionQueue, redisConnection } from "../src/server/ingestion/queue"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { readIngestionHealth } from "../src/server/ingestion/health"
import { compactFailedIngestionStacks } from "../src/server/ingestion/recovery"
import { ingestionFailureCode, ingestionFailureLog, readRetainedDiagnostic } from "../src/server/ingestion/diagnostics"
import { TracerError } from "../src/server/tracer/errors"

function fixture() {
  const url = process.env.DATOOL_TEST_REDIS_URL
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || url === process.env.REDIS_URL)
    throw Error("DATOOL_TEST_REDIS_URL must be a disposable loopback Redis distinct from REDIS_URL")
  const connection = redisConnection(true, url), queue = createIngestionQueue(connection)
  return { connection, queue }
}
const data = () => ({ projectId: crypto.randomUUID(), event: {
  id: crypto.randomUUID(), previousId: null, method: "POST" as const, path: "/api/traces",
  body: { id: crypto.randomUUID(), name: "private event body", startedAt: "2026-09-24T00:00:00Z" },
} })

test("permanent worker failures preserve their code and do not masquerade as unavailable ingestion", async () => {
  const { connection, queue } = fixture()
  await queue.waitUntilReady()
  const input = data()
  const job = await queue.add("lifecycle", input)
  const worker = startIngestionWorker({ connection, database: () => {
    throw new TracerError("VALIDATION_ERROR", "private customer input")
  } })
  try {
    const error = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Expected permanent failure")), 5000)
      worker.on("failed", (failed, error) => {
        if (failed?.id === job.id) { clearTimeout(timer); resolve(error) }
      })
    })
    expect(ingestionFailureCode(error)).toBe("VALIDATION_ERROR")
    const retained = (await queue.getJob(job.id!))!
    expect(await retained.getState()).toBe("failed")
    expect(retained.attemptsMade).toBe(1)
    expect(retained.failedReason).not.toContain("private customer input")
    const diagnostic = readRetainedDiagnostic(retained.failedReason)!
    expect(diagnostic.stage).toBe("database")
    expect(diagnostic.retryable).toBe(false)
    expect(diagnostic.causes[0].frames.some(frame => frame.includes("tests/ingestion-operations.test.ts:"))).toBe(true)
    const log = ingestionFailureLog(retained, error)!
    expect(log).toMatchObject({ event: "ingestion_failed", terminal: true, reason: "VALIDATION_ERROR", projectId: input.projectId, eventId: input.event.id, jobId: job.id, diagnostic })
    expect(JSON.stringify(log)).not.toContain("private customer input")
    // An unresolved job stays measurable beyond the old 20-incident daily cap,
    // without producing another per-minute warning or an availability outage.
    for (let tick = 0; tick < 21; tick++) {
      const health = await readIngestionHealth(queue, connection, Date.now() + tick * 60_000)
      expect(health.reasons).not.toContain("FAILED_EVENTS_RETAINED")
      expect(health.severity).toBe("INFO")
      expect(health.retainedFailureState).toBe(1)
      expect(health.unavailableState).toBe(0)
    }
    await job.remove()
    expect((await readIngestionHealth(queue, connection)).retainedFailureState).toBe(0)
  } finally {
    await worker.close(); await job.remove(); await queue.close(); await connection.quit()
  }
})

test("health detects accepted work without progress, stays quiet on fresh work, and excludes payloads", async () => {
  const { connection, queue } = fixture()
  await queue.waitUntilReady()
  const job = await queue.add("lifecycle", data())
  try {
    const fresh = await readIngestionHealth(queue, connection, job.timestamp + 1000)
    expect(fresh.reasons).not.toContain("INGESTION_NO_PROGRESS")
    const stale = await readIngestionHealth(queue, connection, job.timestamp + 180_000)
    expect(stale.reasons).toContain("INGESTION_NO_PROGRESS")
    expect(stale.severity).toBe("CRITICAL")
    expect(stale.counts.waiting).toBeGreaterThan(0)
    expect(JSON.stringify(stale)).not.toContain("private event body")
    // A real completion score resets the progress check even with old work.
    await connection.zadd(queue.toKey("completed"), job.timestamp + 170_000, "health-test-receipt")
    expect((await readIngestionHealth(queue, connection, job.timestamp + 180_000)).reasons).not.toContain("INGESTION_NO_PROGRESS")
  } finally {
    await connection.zrem(queue.toKey("completed"), "health-test-receipt")
    await job.remove(); await queue.close(); await connection.quit()
  }
})

test("recovery shrinks only failed diagnostics while Redis refuses new writes, preserving replay", async () => {
  const { connection, queue } = fixture()
  await queue.waitUntilReady()
  const original = data()
  const failed = await queue.add("lifecycle", original, { attempts: 1 })
  const worker = startIngestionWorker({ connection, database: () => { throw Error("outage") } })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Expected terminal failure")), 5000)
    worker.on("failed", job => { if (job?.id === failed.id) { clearTimeout(timer); resolve() } })
  })
  await worker.close()
  const waiting = await queue.add("lifecycle", data())
  const stack = "retained diagnostic ".repeat(100)
  const oldStacks = JSON.stringify(Array(120).fill(stack))
  const [, oldLimit] = await connection.config("GET", "maxmemory") as string[]
  try {
    await connection.hset(queue.toKey(failed.id!), "stacktrace", oldStacks)
    await connection.hset(queue.toKey(waiting.id!), "stacktrace", oldStacks)
    // This reproduces the incident: normal allocating writes fail at maxmemory.
    await connection.config("SET", "maxmemory", "1")
    await rejects(connection.set("ingestion-oom-probe", "rejected"), /OOM/)
    let cursor = "0", compacted = 0
    do { const result = await compactFailedIngestionStacks(queue, connection, cursor); cursor = result.cursor; compacted += result.compacted } while (cursor !== "0")
    expect(compacted).toBe(1)
    await connection.config("SET", "maxmemory", oldLimit)
    const retained = (await queue.getJob(failed.id!))!
    expect(retained.data).toEqual(original)
    expect(retained.stacktrace).toEqual([stack])
    expect(await retained.getState()).toBe("failed")
    expect(await connection.hget(queue.toKey(waiting.id!), "stacktrace")).toBe(oldStacks)
    // Concurrent replay must prevent the recovery script from touching the job.
    await connection.hset(queue.toKey(failed.id!), "stacktrace", oldStacks)
    await retained.retry("failed")
    await compactFailedIngestionStacks(queue, connection)
    expect(await connection.hget(queue.toKey(failed.id!), "stacktrace")).toBe(oldStacks)
    expect(await retained.getState()).toBe("waiting")
  } finally {
    await connection.config("SET", "maxmemory", oldLimit)
    await failed.remove(); await waiting.remove(); await queue.close(); await connection.quit()
  }
})
