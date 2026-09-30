import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { spawn } from "node:child_process"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "../src/server/tracer/db"
import {
  createIngestionQueue,
  jobIdFor,
  redisConnection,
} from "../src/server/ingestion/queue"
import { startIngestionWorker } from "../src/server/ingestion/worker"
import { persistEvent } from "../src/server/ingestion/persist"
import { readIngestionHealth } from "../src/server/ingestion/health"
import { type IngestionEvent } from "../src/server/ingestion/events"

test("operator inspection reports real failure and dependency receipts without changing jobs or exposing payloads", async () => {
  const redisUrl = process.env.DATOOL_TEST_REDIS_URL
  if (
    !redisUrl ||
    !["localhost", "127.0.0.1"].includes(new URL(redisUrl).hostname) ||
    redisUrl === process.env.REDIS_URL
  )
    throw new Error("Inspection tests require disposable loopback Redis")
  const target = await createIsolatedPostgres()
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const connection = redisConnection(true, redisUrl)
  const queue = createIngestionQueue(connection)
  const reader = `inspect_${crypto.randomUUID().replaceAll("-", "")}`
  const readerPassword = crypto.randomUUID()
  const readerUrl = new URL(redisUrl)
  readerUrl.username = reader
  readerUrl.password = readerPassword
  let worker: ReturnType<typeof startIngestionWorker> | undefined
  const ids: string[] = []
  const inspect = async (id: string, databaseUrl = target.databaseUrl) => {
    const child = spawn(
      process.execPath,
      ["--no-env-file", "scripts/ingestion-jobs.ts", "inspect", id],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: databaseUrl,
          REDIS_URL: readerUrl.toString(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const { stdout, stderr, code } = await new Promise<{
        stdout: string
        stderr: string
        code: number | null
      }>((resolve, reject) => {
        let stdout = "",
          stderr = ""
        child.stdout.on("data", (value) => {
          stdout += value
        })
        child.stderr.on("data", (value) => {
          stderr += value
        })
        child.on("error", reject)
        child.on("close", (code) => resolve({ stdout, stderr, code }))
      })
      if (code !== 0) throw new Error(stderr)
      expect(stdout).not.toContain("private customer payload")
      return JSON.parse(stdout)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    await queue.waitUntilReady()
    // Exercise the actual operator command with writes denied by Redis itself.
    await connection.acl(
      "SETUSER",
      reader,
      "on",
      `>${readerPassword}`,
      "~bull:datool-ingestion:*",
      "-@all",
      "+@read",
      "+@connection",
      "+info",
      "+eval",
      "+evalsha",
      "+script|load"
    )
    const first: IngestionEvent = {
      id: crypto.randomUUID(),
      previousId: null,
      method: "POST",
      path: "/api/traces",
      body: { id: crypto.randomUUID(), name: "private customer payload" },
    }
    const dependent: IngestionEvent = {
      id: crypto.randomUUID(),
      previousId: first.id,
      method: "PATCH",
      path: `/api/traces/${(first.body as { id: string }).id}`,
      body: { output: "private customer payload" },
    }
    const id = jobIdFor(target.projectId, dependent.id)
    ids.push(id)
    const job = await queue.add(
      "lifecycle",
      { projectId: target.projectId, event: dependent },
      { jobId: id, attempts: 1 }
    )
    worker = startIngestionWorker({ connection, database: () => database })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Expected dependency failure")),
        5000
      )
      worker!.on("failed", (failed) => {
        if (failed?.id === id) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    await worker.close()
    worker = undefined
    const before = await connection.hgetall(queue.toKey(id))
    const meta = await connection.hgetall(queue.toKey("meta"))
    const missing = await inspect(id)
    expect(missing).toMatchObject({
      state: "failed",
      diagnostic: { code: "DEPENDENCY_PENDING", stage: "check_dependency" },
      receipts: { eventSaved: false, predecessorSaved: false },
      predecessor: { state: "absent" },
    })
    expect(await connection.hgetall(queue.toKey(id))).toEqual(before)
    expect(await connection.hgetall(queue.toKey("meta"))).toEqual(meta)

    // The predecessor's queue metadata can expire while its durable receipt remains.
    await persistEvent(database, first)
    const savedPredecessor = await inspect(id)
    expect(savedPredecessor.receipts).toEqual({
      eventSaved: false,
      predecessorSaved: true,
    })
    expect(savedPredecessor.predecessor.state).toBe("absent")
    expect(await job.getState()).toBe("failed")

    const unavailable = await inspect(
      id,
      "postgresql://test:test@127.0.0.1:1/unavailable"
    )
    expect(unavailable.receiptStatus).toBe("unavailable")
    expect(unavailable.receipts).toBeNull()

    // Legacy jobs retain their original data; inspection doesn't pretend it can
    // reconstruct context the old worker discarded, or print arbitrary messages.
    await connection.hset(
      queue.toKey(id),
      "failedReason",
      "private customer payload"
    )
    const legacy = await inspect(id)
    expect(legacy.diagnostic).toBeNull()
    expect(legacy.summary).toContain("Legacy job")
    expect(/^[a-f0-9]{64}$/.test(legacy.legacyFailureFingerprint)).toBe(true)
    expect(
      (
        await database.execute(
          sql`select count(*)::int as n from ingestion_receipts`
        )
      ).rows[0].n
    ).toBe(1)

    // Explicit operator recovery, after the dependency is committed. Inspection
    // reports saved only once the worker has actually created the receipt.
    await job.retry("failed")
    worker = startIngestionWorker({ connection, database: () => database })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Expected successful replay")),
        5000
      )
      worker!.on("completed", (completed) => {
        if (completed.id === id) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    await worker.close()
    worker = undefined
    const recovered = await inspect(id)
    expect(recovered).toMatchObject({
      state: "completed",
      receipts: { eventSaved: true, predecessorSaved: true },
    })
    expect(
      (await readIngestionHealth(queue, connection)).counts.failed
    ).toBe(0)
  } finally {
    await worker?.close()
    for (const id of ids) await (await queue.getJob(id))?.remove()
    await connection.acl("DELUSER", reader)
    await queue.close()
    await connection.quit()
    await closeTracerDatabase(database)
    await target.close()
  }
}, 30_000)
