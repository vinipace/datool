import { rejects } from "node:assert/strict"
import { test, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { getTracerProjectId } from "../src/server/tracer/db"
import { persistEvent } from "../src/server/ingestion/persist"
import { eventDigest, parseIngestionEvent, type IngestionEvent } from "../src/server/ingestion/events"
import { createIngestionQueue, redisConnection, jobIdFor } from "../src/server/ingestion/queue"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { DatoolClient } from "../src/lib/tracer/client"
import { fetchWithRetry } from "../src/lib/tracer/retry"
import { cleanCompletedIngestionJobs, completedIngestionRetentionMs } from "../src/server/ingestion/retention"

const event = (previousId: string | null = null): IngestionEvent => ({ id: crypto.randomUUID(), previousId, method: "POST", path: "/api/traces", body: { id: `trace_${crypto.randomUUID()}`, name: "delivery proof", startedAt: "2026-09-09T00:00:00Z", status: "running" } })
test("retry keeps the same event ID/body and does not retry authentication errors", async () => {
  const bodies: string[] = []
  const client = new DatoolClient({ apiKey: "test", projectId: "project", fetch: (async (_, init) => {
    bodies.push(String(init?.body))
    if (bodies.length === 1) return new Response(null, { status: 503 })
    return Response.json({ data: { status: "queued" } }, { status: 202 })
  }) as typeof fetch })
  await client.request("/api/traces", "POST", { id: "trace", name: "test" })
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe(bodies[1])
  let calls = 0
  await fetchWithRetry((async () => { calls++; return new Response(null, { status: 401 }) }) as typeof fetch, "http://test", {}, { timeoutMs: 50, sleep: async () => {} })
  expect(calls).toBe(1)
})
test("transient retries span a recovery window instead of exhausting immediately", async () => {
  let calls = 0
  const waits: number[] = []
  const response = await fetchWithRetry((async () => {
    calls++
    return new Response(null, { status: 503 })
  }) as typeof fetch, "http://test", {}, { timeoutMs: 50, sleep: async ms => { waits.push(ms) } })
  expect(response.status).toBe(503)
  expect(calls).toBe(9)
  expect(waits).toHaveLength(8)
  expect(waits.reduce((sum, ms) => sum + ms, 0) >= 17875).toBe(true)
})

test("invalid lifecycle paths are rejected before queueing", () => {
  expect(() => parseIngestionEvent({ ...event(), path: "/api/evals" })).toThrow("Unsupported")
})
test("PostgreSQL receipt commits atomically, serializes duplicate delivery, and enforces predecessor order", async () => {
  const db = await createTracerFixture()
  try {
    const first = event()
    const last: IngestionEvent = { id: crypto.randomUUID(), previousId: first.id, path: `/api/traces/${(first.body as { id: string }).id}`, method: "PATCH", body: { status: "completed", endedAt: "2026-09-09T00:00:01Z", output: { saved: true } } }
    await rejects(persistEvent(db, last), /preceding/)
    const results = await Promise.all([persistEvent(db, first), persistEvent(db, first)])
    expect(results[0]).toEqual(results[1])
    await persistEvent(db, last)
    await persistEvent(db, first) // late replay cannot reset the final status
    const rows = await db.execute(sql`select status, output_json from traces`)
    expect(rows.rows).toEqual([{ status: "completed", output_json: '{"saved":true}' }])
    const receipts = await db.execute(sql`select count(*)::integer as count from ingestion_receipts`)
    expect(receipts.rows[0].count).toBe(2)
    await rejects(persistEvent(db, { ...first, body: { ...(first.body as object), name: "changed" } }), /different payload/)
    const invalid: IngestionEvent = { ...event(), body: { id: "bad", name: "missing session", sessionId: "missing" } }
    await rejects(persistEvent(db, invalid))
    const absent = await db.execute(sql`select 1 from ingestion_receipts where event_id = ${invalid.id}::uuid`)
    expect(absent.rowCount).toBe(0)
  } finally { await closeTracerFixture(db) }
})
test("malformed Unicode persists with its original receipt identity and unblocks its successor", async () => {
  const db = await createTracerFixture()
  try {
    const first = event()
    const traceId = (first.body as { id: string }).id
    first.body = { ...(first.body as object), input: { text: "before\ud83d after\udc00\u0000", emoji: "🍀", literal: "\\ud800", "key\ud800": ["\ud800"] } }
    const original = JSON.stringify(first)
    await persistEvent(db, first)
    await persistEvent(db, first)
    const last: IngestionEvent = { id: crypto.randomUUID(), previousId: first.id, path: `/api/traces/${traceId}`, method: "PATCH", body: { status: "completed", endedAt: "2026-09-09T00:00:01Z", output: "saved\ud800" } }
    await persistEvent(db, last)
    const rows = await db.execute(sql`select status, input_json, output_json from traces where id=${traceId}`)
    expect(rows.rows).toEqual([{ status: "completed", input_json: JSON.stringify({ text: "before� after��", emoji: "🍀", literal: "\\ud800", "key�": ["�"] }), output_json: '"saved�"' }])
    const receipt = await db.execute(sql`select digest from ingestion_receipts where event_id=${first.id}::uuid`)
    expect(receipt.rows[0].digest).toBe(eventDigest(first))
    expect(JSON.stringify(first)).toBe(original)
    const colliding = event()
    colliding.body = { ...(colliding.body as object), input: { "\ud800": 1, "�": 2 } }
    await rejects(persistEvent(db, colliding), /keys collide/)
    const absent = await db.execute(sql`select 1 from ingestion_receipts where event_id=${colliding.id}::uuid`)
    expect(absent.rowCount).toBe(0)
  } finally { await closeTracerFixture(db) }
})

test("Redis retains events without a worker and retries persistence before saving once", async () => {
  const db = await createTracerFixture()
  const url = process.env.DATOOL_TEST_REDIS_URL
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("DATOOL_TEST_REDIS_URL must point at isolated local Redis")
  const producer = redisConnection(false, url)
  const connection = redisConnection(true, url)
  const queue = createIngestionQueue(producer)
  let worker: ReturnType<typeof startIngestionWorker> | undefined
  try {
    await queue.waitUntilReady()
    const data = { projectId: getTracerProjectId(db), event: event() }
    const job = await queue.add("lifecycle", data, { jobId: jobIdFor(data.projectId, data.event.id), backoff: { type: "fixed", delay: 50 } })
    expect(await job.getState()).toBe("waiting")
    let attempts = 0
    worker = startIngestionWorker({ connection, database: () => {
      if (++attempts === 1) throw new Error("simulated database outage")
      return db
    } })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not recover")), 10_000)
      worker!.on("completed", completed => { if (completed.id === job.id) { clearTimeout(timer); resolve() } })
      worker!.on("error", reject)
    })
    expect(attempts).toBe(2)
    expect(await job.getState()).toBe("completed")
    const rows = await db.execute(sql`select count(*)::integer as count from traces`)
    expect(rows.rows[0].count).toBe(1)
    await job.remove()
  } finally {
    await worker?.close()
    await queue.close()
    await connection.quit()
    await producer.quit()
    await closeTracerFixture(db)
  }
})

test("exhausted retries retain the event but only one safe diagnostic stack, including legacy jobs", async () => {
  const url = process.env.DATOOL_TEST_REDIS_URL
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("DATOOL_TEST_REDIS_URL must point at isolated local Redis")
  const producer = redisConnection(false, url)
  const connection = redisConnection(true, url)
  const queue = createIngestionQueue(producer)
  let worker: ReturnType<typeof startIngestionWorker> | undefined
  let job: Awaited<ReturnType<typeof queue.add>> | undefined
  try {
    await queue.waitUntilReady()
    expect(queue.opts.defaultJobOptions?.stackTraceLimit).toBe(1)
    const data = { projectId: crypto.randomUUID(), event: event() }
    job = await queue.add("lifecycle", data, { jobId: jobIdFor(data.projectId, data.event.id), attempts: 5, backoff: { type: "fixed", delay: 10 }, stackTraceLimit: 120 })
    worker = startIngestionWorker({ connection, database: () => {
      throw Object.assign(new Error("SQL parameters: private customer content"), { code: "08006" })
    } })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not exhaust retries")), 10_000)
      worker!.on("failed", failed => {
        if (failed && failed.id === job!.id && failed.attemptsMade === 5) { clearTimeout(timer); resolve() }
      })
      worker!.on("error", reject)
    })
    const retained = await queue.getJob(job.id!)
    expect(await retained!.getState()).toBe("failed")
    expect(retained!.data).toEqual(data)
    expect(retained!.attemptsMade).toBe(5)
    expect(retained!.stacktrace).toHaveLength(1)
    expect(retained!.failedReason).toContain("POSTGRES_08006")
    expect(JSON.stringify(retained!.stacktrace)).not.toContain("private customer content")
  } finally {
    await worker?.close()
    await job?.remove()
    await queue.close()
    await connection.quit()
    await producer.quit()
  }
})

test("idle queue cleanup expires only completed metadata and preserves receipts, replay, and pending events", async () => {
  const db = await createTracerFixture()
  const url = process.env.DATOOL_TEST_REDIS_URL
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("DATOOL_TEST_REDIS_URL must point at isolated local Redis")
  const producer = redisConnection(false, url)
  const connection = redisConnection(true, url)
  const queue = createIngestionQueue(producer)
  let worker: ReturnType<typeof startIngestionWorker> | undefined
  const ids: string[] = []
  const add = async (input: IngestionEvent, options = {}) => {
    const projectId = getTracerProjectId(db)
    const id = jobIdFor(projectId, input.id)
    ids.push(id)
    return queue.add("lifecycle", { projectId, event: input }, { jobId: id, ...options })
  }
  const waitForState = async (id: string, state: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await (await queue.getJob(id))?.getState() === state) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Expected job state ${state}`)
  }
  try {
    worker = startIngestionWorker({ connection, database: () => db })
    const first = event()
    const old = await add(first, { removeOnComplete: false })
    const fresh = await add(event(), { removeOnComplete: false })
    const failed = await add(event(crypto.randomUUID()), { attempts: 1 })
    await waitForState(old.id!, "completed")
    await waitForState(fresh.id!, "completed")
    await waitForState(failed.id!, "failed")
    await worker.close()
    worker = undefined
    const waiting = await add(event())
    const expiredAt = Date.now() - completedIngestionRetentionMs - 1000
    await producer.hset(queue.toKey(old.id!), "finishedOn", expiredAt)
    await producer.zadd(queue.toKey("completed"), expiredAt, old.id!)
    expect(await cleanCompletedIngestionJobs(queue)).toEqual([old.id!])
    expect(await queue.getJob(old.id!)).toBeUndefined()
    expect(await fresh.getState()).toBe("completed")
    expect(await failed.getState()).toBe("failed")
    expect(await waiting.getState()).toBe("waiting")
    const receipt = await db.execute(sql`select 1 from ingestion_receipts where event_id = ${first.id}::uuid`)
    expect(receipt.rowCount).toBe(1)
    // Same-ID replay still succeeds and cannot insert a duplicate trace.
    await add(first)
    worker = startIngestionWorker({ connection, database: () => db })
    await waitForState(old.id!, "completed")
    await waitForState(waiting.id!, "completed")
    const traces = await db.execute(sql`select count(*)::integer as count from traces`)
    expect(traces.rows[0].count).toBe(3)
  } finally {
    await worker?.close()
    for (const id of new Set(ids)) await (await queue.getJob(id))?.remove()
    await queue.close()
    await connection.quit()
    await producer.quit()
    await closeTracerFixture(db)
  }
})
