import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import type { AddressInfo } from "node:net"
function launch(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(args[0], args.slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve)
    child.once("error", reject)
  })
  return {
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    exited,
    get exitCode() {
      return child.exitCode
    },
    kill: (signal: NodeJS.Signals = "SIGTERM") => child.kill(signal),
  }
}
import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  LangfuseClient,
  SourceError,
  type Kind,
} from "@/src/server/imports/langfuse/client"
import {
  createRun,
  destinationId,
  readRun,
  report,
} from "@/src/server/imports/langfuse/store"
import { runImport } from "@/src/server/imports/langfuse/runner"
import { analyticsAttributes } from "@/src/server/imports/langfuse/mapper"
import { backfillAnalytics } from "@/src/server/imports/langfuse/backfill"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  getTracerProjectId,
  registerTracerProjectId,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"

const from = "2025-05-01T00:00:00.000Z",
  to = "2025-05-02T00:00:00.000Z"
const at = "2025-05-01T12:00:00.000Z",
  ended = "2025-05-01T12:00:02.000Z"
const sourceProjectId = "langfuse-project"
async function fakeSource(
  options: {
    modern?: boolean
    noContainers?: boolean
    invalid?: boolean
    totalDrift?: boolean
  } = {}
) {
  const requests: { path: string; token: string | null }[] = []
  let rateLimited = false
  const records: Record<Kind, Record<string, unknown>[]> = {
    sessions: [
      { id: "s1", projectId: sourceProjectId, createdAt: at },
      { id: "empty-session", projectId: sourceProjectId, createdAt: at },
    ],
    traces: [
      {
        id: "t1",
        projectId: sourceProjectId,
        timestamp: at,
        name: "Original trace",
        sessionId: "s1",
        input: { question: "hello" },
        output: "answer",
        latency: 2,
        totalCost: 0.3,
        metadata: { keep: true },
        tags: ["test"],
      },
    ],
    observations: [
      {
        id: "a-child",
        projectId: sourceProjectId,
        traceId: "t1",
        parentObservationId: "z-root",
        type: "GENERATION",
        startTime: at,
        endTime: ended,
        name: "LLM",
        model: "test-model",
        input: options.modern ? '{"messages":[]}' : { messages: [] },
        output: options.modern ? '"answer"' : "answer",
        totalCost: 0.3,
        inputUsage: 10,
        outputUsage: 4,
        usageDetails: {
          input: 7,
          output: 3,
          input_cached_tokens: 3,
          output_reasoning_tokens: 1,
        },
        costDetails: {
          input: 0.1,
          output: 0.1,
          input_cached_tokens: 0.04,
          output_reasoning_tokens: 0.06,
          total: 0.3,
        },
        timeToFirstToken: 0.2,
        metadata: {
          preserve: "child",
          "attributes.ai.telemetry.functionId": "test-call",
        },
        sessionId: "s1",
      },
      {
        id: "z-root",
        projectId: sourceProjectId,
        traceId: "t1",
        parentObservationId: null,
        type: "SPAN",
        startTime: at,
        endTime: ended,
        name: "Root",
        traceName: "Reconstructed trace",
        sessionId: "s1",
        input: options.modern ? '{"question":"hello"}' : { question: "hello" },
        output: options.modern ? '"answer"' : "answer",
      },
    ],
    scores: [
      {
        id: "numeric",
        projectId: sourceProjectId,
        name: "Quality",
        dataType: "NUMERIC",
        value: 8.5,
        timestamp: ended,
        source: "API",
        comment: "Original",
        ...(options.modern
          ? { subject: { kind: "observation", id: "a-child", traceId: "t1" } }
          : { observationId: "a-child", traceId: "t1" }),
      },
      {
        id: "boolean",
        projectId: sourceProjectId,
        name: "Accepted",
        dataType: "BOOLEAN",
        value: options.modern ? false : 0,
        timestamp: ended,
        source: "ANNOTATION",
        authorUserId: "user-1",
        ...(options.modern
          ? { subject: { kind: "session", id: "s1" } }
          : { sessionId: "s1" }),
      },
      {
        id: "category",
        projectId: sourceProjectId,
        name: "Category",
        dataType: "CATEGORICAL",
        value: options.modern ? "good" : 1,
        stringValue: "good",
        timestamp: ended,
        source: "API",
        ...(options.modern
          ? { subject: { kind: "trace", id: "t1" } }
          : { traceId: "t1" }),
      },
    ],
  }
  if (options.invalid) {
    records.observations.push({
      id: "missing-parent",
      traceId: "t1",
      parentObservationId: "outside-window",
      type: "TOOL",
      name: "Missing",
      startTime: at,
      endTime: ended,
    })
    records.observations.push({
      id: "unknown",
      traceId: "t1",
      type: "FUTURE_KIND",
      startTime: at,
      endTime: ended,
    })
    records.scores.push({
      id: "correction",
      dataType: "CORRECTION",
      name: "Correction",
      value: { nested: true },
      timestamp: ended,
      traceId: "t1",
    })
    records.scores.push({
      id: "unresolved",
      dataType: "NUMERIC",
      name: "Missing target",
      value: 0,
      timestamp: ended,
      traceId: "not-imported",
      ...(options.modern
        ? { subject: { kind: "trace", id: "not-imported" } }
        : {}),
    })
  }
  const handle = (request: Request) => {
    const url = new URL(request.url),
      path = url.pathname
    if (
      request.headers.get("authorization") !==
      `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`
    )
      return new Response("private body should never be logged", {
        status: 401,
      })
    if (path === "/api/public/projects")
      return Response.json({ data: [{ id: sourceProjectId }] })
    const kind = path.split("/").at(-1) as Kind
    if (!records[kind]) return new Response(null, { status: 404 })
    if (options.noContainers && ["sessions", "traces"].includes(kind))
      return new Response(null, { status: 410 })
    const modern =
      path.includes("/v2/observations") || path.includes("/v3/scores")
    if (modern && !options.modern) return new Response(null, { status: 404 })
    if (
      options.modern &&
      (kind === "observations" || kind === "scores") &&
      !modern
    )
      return new Response(null, { status: 410 })
    const token = url.searchParams.get(modern ? "cursor" : "page")
    requests.push({ path, token })
    if (kind === "observations" && !rateLimited) {
      rateLimited = true
      return new Response("secret error body", {
        status: 429,
        headers: { "retry-after": "0" },
      })
    }
    if (
      url.searchParams.get(
        kind === "observations" ? "fromStartTime" : "fromTimestamp"
      ) !== from ||
      url.searchParams.get(
        kind === "observations" ? "toStartTime" : "toTimestamp"
      ) !== to
    )
      return new Response(null, { status: 400 })
    if (
      modern &&
      kind === "observations" &&
      !url.searchParams.get("fields")?.includes("io")
    )
      return new Response(null, { status: 400 })
    if (
      modern &&
      kind === "scores" &&
      url.searchParams.get("fields") !== "details,subject,annotation"
    )
      return new Response(null, { status: 400 })
    const size = Number(url.searchParams.get("limit")),
      page =
        Number(token?.replace("cursor-", "") ?? (modern ? 0 : 1)) -
        (modern ? 0 : 1)
    const data = records[kind].slice(page * size, (page + 1) * size)
    return Response.json({
      data,
      meta: modern
        ? {
            cursor:
              (page + 1) * size < records[kind].length
                ? `cursor-${page + 1}`
                : null,
          }
        : {
            page: page + 1,
            totalPages: Math.ceil(records[kind].length / size),
            totalItems: records[kind].length + (options.totalDrift ? 1 : 0),
            limit: size,
          },
    })
  }
  const server = createServer(async (request, response) => {
    const result = handle(
      new Request(`http://localhost${request.url}`, {
        headers: request.headers as Record<string, string>,
      })
    )
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const credentials = {
    host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
  }
  return {
    server: {
      stop: () => {
        server.closeAllConnections()
        server.close()
      },
    },
    credentials,
    client: () => new LangfuseClient(credentials, { sleep: async () => {} }),
    requests,
    records,
  }
}

for (const modern of [false, true])
  test(`Langfuse ${modern ? "modern" : "legacy"} import preserves values, graph, timestamps and accounting across overlapping runs`, async () => {
    const db = await createTracerFixture(),
      fake = await fakeSource({ modern })
    try {
      const run = await createRun(db, {
        host: fake.credentials.host,
        sourceProjectId,
        from,
        to,
        pageSize: 1,
      })
      const done = await runImport(db, run.id, fake.client())
      expect(done.status).toBe("completed")
      expect(done.counts.reduce((sum, row) => sum + Number(row.count), 0)).toBe(
        8
      )
      const trace = await runTracerEffect(
        new TracerService(db).getTrace(destinationId(run, "traces", "t1"))
      )
      expect(trace.input).toEqual({ question: "hello" })
      expect(trace.startedAt).toBe(at)
      expect(trace.endedAt).toBe(ended)
      const child = trace.spans.find((span) => span.name === "LLM")!
      expect(child.parentId).toBe(destinationId(run, "observations", "z-root"))
      expect(child.input).toEqual({ messages: [] })
      expect(child.output).toBe("answer")
      expect(child.attributes).toMatchObject({
        "cost.usd": 0.3,
        "usage.input_tokens": 10,
        "usage.output_tokens": 4,
        "usage.cache_read_tokens": 3,
        "usage.reasoning_tokens": 1,
        "ai.telemetry.functionId": "test-call",
        "cost.breakdown": {
          inputUSD: 0.1,
          outputUSD: 0.16,
          cacheReadsUSD: 0.04,
        },
        "ttft.ms": 200,
      })
      expect(
        trace.scores.find((score) => score.name === "Quality")
      ).toMatchObject({
        score: 8.5,
        valueLabel: "8.5",
        external: { target: { type: "span", id: child.id } },
      })
      expect(
        trace.scores.find((score) => score.name === "Category")?.valueLabel
      ).toBe("good")
      const boolean = (
        await db.execute(
          sql`select external_json from scores where name='Accepted'`
        )
      ).rows[0].external_json
      expect(boolean).toMatchObject({
        data: { type: "boolean", value: false },
        target: { type: "session", id: destinationId(run, "sessions", "s1") },
        author: "user-1",
      })
      expect(
        (
          await db.execute(
            sql`select created_at from sessions where id=${destinationId(run, "sessions", "s1")}`
          )
        ).rows[0].created_at
      ).toBe(at)
      const raw = (
        await db.execute(
          sql`select raw from langfuse_import_records where run_id=${run.id} and kind='observations' and source_id='a-child'`
        )
      ).rows[0].raw
      expect(raw).toEqual(fake.records.observations[0])
      const second = await createRun(db, {
        host: fake.credentials.host,
        sourceProjectId,
        from,
        to,
        pageSize: 2,
      })
      expect((await runImport(db, second.id, fake.client())).status).toBe(
        "completed"
      )
      expect(
        (await db.execute(sql`select count(*)::int as count from traces`))
          .rows[0].count
      ).toBe(1)
      expect(
        (await db.execute(sql`select count(*)::int as count from spans`))
          .rows[0].count
      ).toBe(2)
      expect(
        (await db.execute(sql`select count(*)::int as count from scores`))
          .rows[0].count
      ).toBe(3)
      expect(
        (await db.execute(sql`select sum(cost_usd) as cost from spans`)).rows[0]
          .cost
      ).toBe(0.3)
      expect(
        (await db.execute(sql`select cost_usd from traces`)).rows[0].cost_usd
      ).toBeNull()
    } finally {
      fake.server.stop()
      await closeTracerFixture(db)
    }
  })

test("fetch resumes after a committed page and retains unsupported/unresolved source records", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource({ modern: true, invalid: true })
  try {
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
      pageSize: 1,
    })
    let committed = 0
    await assert.rejects(
      runImport(db, run.id, fake.client(), {
        afterPage: async () => {
          if (++committed === 4)
            throw new SourceError("IMPORT_INTERRUPTED", true)
        },
      })
    )
    expect((await readRun(db, run.id)).checkpoint).toMatchObject({
      phase: "observations",
      token: "cursor-1",
    })
    fake.requests.length = 0
    const result = await runImport(db, run.id, fake.client())
    expect(fake.requests[0]).toMatchObject({
      path: "/api/public/v2/observations",
      token: "cursor-1",
    })
    expect(result.status).toBe("completed_with_issues")
    expect(result.issues).toHaveLength(4)
    expect(result.counts.reduce((sum, row) => sum + Number(row.count), 0)).toBe(
      12
    )
    expect(
      (
        await db.execute(
          sql`select raw from langfuse_import_records where run_id=${run.id} and source_id='correction'`
        )
      ).rows[0].raw
    ).toEqual(fake.records.scores.find((s) => s.id === "correction"))
    const before = await report(db, run.id)
    const after = await runImport(db, run.id, fake.client())
    expect(after.counts).toEqual(before.counts)
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("new APIs reconstruct unavailable trace/session containers and report the limitation", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource({ modern: true, noContainers: true })
  try {
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    const result = await runImport(db, run.id, fake.client())
    expect(result.status).toBe("completed_with_issues")
    expect(result.checkpoint.warnings).toEqual([
      "ORIGINAL_SESSIONS_API_UNAVAILABLE",
      "ORIGINAL_TRACES_API_UNAVAILABLE",
    ])
    const trace = await runTracerEffect(
      new TracerService(db).getTrace(destinationId(run, "traces", "t1"))
    )
    expect(trace.name).toBe("Reconstructed trace")
    expect(trace.input).toEqual({ question: "hello" })
    expect(trace.spans).toHaveLength(2)
    expect(trace.attributes["import.source"]).toMatchObject({
      reconstructed: true,
    })
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("source identity, tenant boundaries, changed records and source count mismatches are enforced", async () => {
  const db = await createTracerFixture(),
    otherDb = reopenTracerFixture(db),
    fake = await fakeSource({ totalDrift: true })
  try {
    const project = getTracerProjectId(db),
      other = crypto.randomUUID()
    await db.execute(
      sql`insert into project(id,organization_id,name,slug,created_at,updated_at) select ${other},organization_id,'Other','other',created_at,updated_at from project where id=${project}`
    )
    registerTracerProjectId(otherDb, other)
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    await assert.rejects(readRun(otherDb, run.id), /IMPORT_NOT_FOUND/)
    await assert.rejects(
      runImport(
        db,
        run.id,
        new LangfuseClient({ ...fake.credentials, secretKey: "wrong" })
      ),
      /LANGFUSE_HTTP_401/
    )
    expect((await readRun(db, run.id)).error_code).toBe("LANGFUSE_HTTP_401")
    const result = await runImport(db, run.id, fake.client())
    expect(result.status).toBe("completed_with_issues")
    expect(result.checkpoint.warnings).toContain("SOURCE_COUNT_MISMATCH_TRACES")
    fake.records.traces[0].output = "changed"
    const next = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    const changed = await runImport(db, next.id, fake.client())
    expect(changed.issues.find((row) => row.sourceId === "t1")).toEqual({
      kind: "traces",
      sourceId: "t1",
      status: "conflict",
      reason: "SOURCE_CHANGED_SINCE_PREVIOUS_IMPORT",
    })
    const trace = await runTracerEffect(
      new TracerService(db).getTrace(destinationId(run, "traces", "t1"))
    )
    expect(trace.output).toBe("answer")
  } finally {
    fake.server.stop()
    await closeTracerDatabase(otherDb)
    await closeTracerFixture(db)
  }
})

// Full local process boundary: CLI -> Redis job -> independent worker -> PostgreSQL -> status CLI.
test("local CLI and Redis worker complete a real import without credentials in job data", async () => {
  const fake = await fakeSource({ modern: true })
  const { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } =
    await import("./helpers/postgres")
  const target = await createIsolatedPostgres()
  let worker: ReturnType<typeof launch> | undefined
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    if (!process.env.DATOOL_TEST_REDIS_URL)
      throw new Error("DATOOL_TEST_REDIS_URL required")
    const env = {
      ...process.env,
      DATABASE_URL: target.databaseUrl,
      DATABASE_READONLY_URL: target.databaseUrl,
      REDIS_URL: process.env.DATOOL_TEST_REDIS_URL,
      LANGFUSE_HOST: fake.credentials.host,
      LANGFUSE_PUBLIC_KEY: fake.credentials.publicKey,
      LANGFUSE_SECRET_KEY: fake.credentials.secretKey,
    }
    async function cli(args: string[]) {
      const child = launch(
        [
          process.execPath,
          "--no-env-file",
          "scripts/langfuse-import.ts",
          ...args,
        ],
        env
      )
      const output = await new Response(child.stdout).text(),
        error = await new Response(child.stderr).text()
      expect(await child.exited).toBe(0)
      expect(error).toBe("")
      return output
    }
    const output = await cli([
      "start",
      "--project",
      target.projectId,
      "--from",
      from,
      "--to",
      to,
      "--page-size",
      "1",
    ])
    const runId = JSON.parse(output.trim().split("\n")[0]).runId
    const { redisConnection } = await import("@/src/server/ingestion/queue")
    const { createImportQueue } =
      await import("@/src/server/imports/langfuse/worker")
    const connection = redisConnection(
        false,
        process.env.DATOOL_TEST_REDIS_URL
      ),
      queue = createImportQueue(connection)
    try {
      expect((await queue.getJob(runId))?.data).toEqual({
        projectId: target.projectId,
        runId,
      })
    } finally {
      await queue.close()
      await connection.quit()
    }
    worker = launch(
      [
        process.execPath,
        "--no-env-file",
        "scripts/langfuse-import.ts",
        "worker",
      ],
      env
    )
    let result: { status: string } | undefined
    for (let i = 0; i < 30; i++) {
      result = JSON.parse(
        await cli(["status", "--project", target.projectId, "--run", runId])
      )
      if (result?.status === "completed") break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(result?.status).toBe("completed")
    worker.kill("SIGTERM")
    expect(await worker.exited).toBe(0)
    const error = await new Response(worker.stderr).text()
    expect(error).toBe("")
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill()
      await worker.exited
    }
    fake.server.stop()
    await target.close()
  }
}, 30000)

test("client rejects malformed pagination and respects long Retry-After without exposing response bodies", async () => {
  const credentials = {
    host: "https://langfuse.example",
    publicKey: "pk",
    secretKey: "private-secret",
  }
  const malformed = new LangfuseClient(credentials, {
    fetch: async () => Response.json({ data: [], meta: {} }),
  })
  await assert.rejects(
    malformed.page("traces", "legacy", from, to, null, 1),
    /LANGFUSE_INVALID_PAGE_META/
  )
  const stalled = new LangfuseClient(credentials, {
    fetch: async () =>
      Response.json({ data: [{ id: "x" }], meta: { cursor: "same" } }),
  })
  await assert.rejects(
    stalled.page("observations", "modern", from, to, "same", 1),
    /LANGFUSE_PAGINATION_STALLED/
  )
  const limited = new LangfuseClient(credentials, {
    fetch: async () =>
      new Response("do-not-leak-this", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  })
  await assert.rejects(limited.project(), (error: unknown) => {
    assert(error instanceof SourceError)
    expect(error.retryAfterMs).toBe(120000)
    expect(error.message).toBe("LANGFUSE_LONG_RATE_LIMIT")
    return true
  })
  const auth = new LangfuseClient(credentials, {
    fetch: async () => new Response("private response", { status: 401 }),
  })
  await assert.rejects(auth.project(), /LANGFUSE_HTTP_401/)
})

test("a foreign-project row rolls back its entire fetched page and checkpoint", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource()
  try {
    fake.records.sessions[1].projectId = "foreign-project"
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
      pageSize: 50,
    })
    await assert.rejects(
      runImport(db, run.id, fake.client()),
      /LANGFUSE_RECORD_PROJECT_MISMATCH/
    )
    const state = await report(db, run.id)
    expect(state.counts).toHaveLength(0)
    expect(state.pages).toHaveLength(0)
    expect(state.checkpoint).toMatchObject({ phase: "sessions", token: null })
    expect(state.errorCode).toBe("LANGFUSE_RECORD_PROJECT_MISMATCH")
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("native persistence failure resumes materialization without refetching or duplicating entities", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource()
  try {
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    await db.execute(
      sql`create function reject_import_span() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`
    )
    await db.execute(
      sql`create trigger reject_import_span before insert on spans for each row execute function reject_import_span()`
    )
    await assert.rejects(
      runImport(db, run.id, fake.client()),
      /IMPORT_PERSISTENCE_OR_WORKER_ERROR/
    )
    expect((await readRun(db, run.id)).checkpoint.phase).toBe("materialize")
    expect(
      (await db.execute(sql`select count(*)::int as count from spans`)).rows[0]
        .count
    ).toBe(0)
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from langfuse_import_entities where kind='observations'`
        )
      ).rows[0].count
    ).toBe(0)
    await db.execute(sql`drop trigger reject_import_span on spans`)
    fake.requests.length = 0
    expect((await runImport(db, run.id, fake.client())).status).toBe(
      "completed"
    )
    expect(fake.requests).toHaveLength(0)
    expect(
      (await db.execute(sql`select count(*)::int as count from traces`)).rows[0]
        .count
    ).toBe(1)
    expect(
      (await db.execute(sql`select count(*)::int as count from spans`)).rows[0]
        .count
    ).toBe(2)
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("instantaneous events and offset timestamps produce correct trace end times without relabeling non-token usage", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource()
  try {
    fake.records.observations[0].usage = {
      input: 10,
      output: 4,
      unit: "CHARACTERS",
    }
    fake.records.observations.push({
      id: "event",
      traceId: "t1",
      type: "EVENT",
      name: "Event",
      startTime: "2025-05-01T09:00:03-03:00",
      endTime: null,
      parentObservationId: "z-root",
    })
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    expect((await runImport(db, run.id, fake.client())).status).toBe(
      "completed"
    )
    const trace = await runTracerEffect(
      new TracerService(db).getTrace(destinationId(run, "traces", "t1"))
    )
    expect(trace.endedAt).toBe("2025-05-01T12:00:03.000Z")
    expect(trace.spans.find((span) => span.name === "Event")).toMatchObject({
      startedAt: "2025-05-01T12:00:03.000Z",
      endedAt: "2025-05-01T12:00:03.000Z",
      status: "completed",
    })
    const attrs = trace.spans.find((span) => span.name === "LLM")!.attributes
    expect(attrs["usage.input_tokens"]).toBeUndefined()
    expect(attrs["langfuse.usage"]).toMatchObject({ unit: "CHARACTERS" })
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("analytical aliases preserve zeros, reject invalid values and do not promote arbitrary metadata", () => {
  expect(
    analyticsAttributes({
      metadata: { "ai.functionId": "legacy-call", password: "do-not-promote" },
      usageDetails: {
        input_cached_tokens: 0,
        cache_read_input_tokens: 9,
        output_reasoning_tokens: 2,
      },
      costDetails: {
        input: 0,
        output: 0.2,
        output_reasoning_tokens: 0.3,
        input_cached_tokens: 0,
      },
    })
  ).toEqual({
    "ai.telemetry.functionId": "legacy-call",
    "usage.cache_read_tokens": 0,
    "usage.reasoning_tokens": 2,
    "cost.breakdown": { inputUSD: 0, outputUSD: 0.5, cacheReadsUSD: 0 },
  })
  expect(
    analyticsAttributes({
      metadata: { "ai.telemetry.functionId": { invalid: true } },
      usageDetails: {
        input_cached_tokens: -1,
        cache_creation_input_tokens: 1.5,
      },
      costDetails: { input: -1, output: Infinity, input_cached_tokens: "0.1" },
    })
  ).toEqual({})
  expect(
    analyticsAttributes({
      usage: { unit: "CHARACTERS" },
      usageDetails: { input_cached_tokens: 4 },
    })
  ).toEqual({})
})

test("flat usage buckets become inclusive totals without double counting exported totals", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource({ modern: true })
  try {
    delete fake.records.observations[0].inputUsage
    delete fake.records.observations[0].outputUsage
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    await runImport(db, run.id, fake.client())
    const rows = (
      await db.execute(
        sql`select input_tokens,output_tokens,cached_tokens from spans where kind='llm'`
      )
    ).rows
    expect(rows[0]).toMatchObject({
      input_tokens: 10,
      output_tokens: 4,
      cached_tokens: 3,
    })
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})

test("separate backfill repairs archived imports, is repeatable and preserves totals, archives and edits", async () => {
  const db = await createTracerFixture(),
    fake = await fakeSource({ modern: true })
  try {
    const run = await createRun(db, {
      host: fake.credentials.host,
      sourceProjectId,
      from,
      to,
    })
    await runImport(db, run.id, fake.client())
    const id = destinationId(run, "observations", "a-child")
    const fresh = (
      await db.execute(sql`select attributes_json from spans where id=${id}`)
    ).rows[0].attributes_json
    const before = (
      await db.execute(
        sql`select count(*)::int as count,sum(cost_usd) as cost,sum(input_tokens) as input,sum(output_tokens) as output from spans`
      )
    ).rows[0]
    const archives = (
      await db.execute(
        sql`select id,raw from langfuse_import_entities order by id`
      )
    ).rows
    await db.execute(
      sql`update spans set attributes_json=attributes_json - array['ai.telemetry.functionId','usage.cache_read_tokens','usage.reasoning_tokens','cost.breakdown'] where id=${id}`
    )
    expect(await backfillAnalytics(db, { dryRun: true })).toMatchObject({
      scanned: 2,
      changed: 1,
      conflicts: 0,
    })
    expect(
      (await db.execute(sql`select cached_tokens from spans where id=${id}`))
        .rows[0].cached_tokens
    ).toBeNull()
    const projectId = getTracerProjectId(db)
    registerTracerProjectId(db, "unrelated-project")
    expect(await backfillAnalytics(db)).toMatchObject({
      scanned: 0,
      changed: 0,
    })
    registerTracerProjectId(db, projectId)
    expect(await backfillAnalytics(db)).toMatchObject({
      scanned: 2,
      changed: 1,
      conflicts: 0,
    })
    expect(
      (await db.execute(sql`select attributes_json from spans where id=${id}`))
        .rows[0].attributes_json
    ).toEqual(fresh)
    expect(await backfillAnalytics(db)).toMatchObject({
      changed: 0,
      conflicts: 0,
    })
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count,sum(cost_usd) as cost,sum(input_tokens) as input,sum(output_tokens) as output from spans`
        )
      ).rows[0]
    ).toEqual(before)
    expect(
      (
        await db.execute(
          sql`select id,raw from langfuse_import_entities order by id`
        )
      ).rows
    ).toEqual(archives)
    await db.execute(
      sql`update spans set attributes_json=attributes_json || '{"ai.telemetry.functionId":"user-edited","cost.breakdown":{"inputUSD":0.12},"custom":"keep"}'::jsonb where id=${id}`
    )
    expect(await backfillAnalytics(db)).toMatchObject({
      changed: 1,
      conflicts: 1,
    })
    expect(
      (await db.execute(sql`select attributes_json from spans where id=${id}`))
        .rows[0].attributes_json
    ).toMatchObject({
      "ai.telemetry.functionId": "user-edited",
      custom: "keep",
      "cost.breakdown": {
        inputUSD: 0.12,
        outputUSD: 0.16,
        cacheReadsUSD: 0.04,
      },
    })
    expect(await backfillAnalytics(db)).toMatchObject({
      changed: 0,
      conflicts: 1,
    })
    await db.execute(
      sql`update spans set attributes_json=attributes_json - array['import.source','ai.telemetry.functionId'] where id=${id}`
    )
    expect(await backfillAnalytics(db)).toMatchObject({
      scanned: 1,
      changed: 0,
      conflicts: 0,
    })
  } finally {
    fake.server.stop()
    await closeTracerFixture(db)
  }
})
