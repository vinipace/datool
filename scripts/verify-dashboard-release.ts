/** Owned local PostgreSQL/Redis, production build, authenticated reads and concurrent ingestion. */
import assert from "node:assert/strict"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "../tests/helpers/postgres"
import { dashboardTemplates } from "../src/lib/tracer/dashboard-templates"
import { dashboardQueryPlan } from "../src/lib/tracer/dashboard-query-plan"
import {
  dashboardFilterScope,
  scopedWidget,
} from "../src/lib/tracer/dashboard-queries"
import {
  DashboardRequestError,
  retryDashboardMetricRead,
} from "../src/lib/tracer/dashboard-read-retry"
import type { SemanticResult } from "../src/lib/semantic/result"

const output = ".tmp/dashboard-release"
await mkdir(output, { recursive: true })
const id = crypto.randomUUID()
const secrets = [crypto.randomUUID(), crypto.randomUUID()]
const containers: string[] = []
const children: ChildProcess[] = []
const pools: Pool[] = []
let target: IsolatedPostgres | undefined
let closeFixture: (() => Promise<void>) | undefined
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  spans: 200000,
  traces: 40001,
  cases: 50000,
}
const samples: {
  scenario: string
  elapsedMs: number
  retries: number
  cache: string | null
}[] = []
const busyResponses: { retryAfter: string | null; elapsedMs: number }[] = []
const writes: {
  eventId: string
  status: number
  acceptedMs: number
  persistedMs?: number
}[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (ms: number) => Math.round(ms)
const redact = (value: string) =>
  secrets.reduce(
    (result, secret) => result.replaceAll(secret, "[redacted]"),
    value
  )
const start = (
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  children.push(child)
  const log = createWriteStream(`${output}/${name}.log`)
  child.stdout?.on("data", (chunk) => log.write(redact(String(chunk))))
  child.stderr?.on("data", (chunk) => log.write(redact(String(chunk))))
  child.on("exit", () => log.end())
  return child
}
const command = async (
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => {
  const child = start(name, process.execPath, args, env)
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  assert.equal(code, 0, `${name} failed; see ${output}/${name}.log`)
}
const container = (image: string, port: string, args: string[] = []) => {
  const name = `datool-dashboard-${port}-${id}`
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1::${port}`,
      ...args,
      image,
    ],
    { stdio: "pipe" }
  )
  containers.push(name)
  return execFileSync("docker", ["port", name, `${port}/tcp`], {
    encoding: "utf8",
  })
    .trim()
    .split(":")
    .at(-1)
}
try {
  const pgPort = container("pgvector/pgvector:pg16", "5432", [
    "-e",
    `POSTGRES_PASSWORD=${secrets[0]}`,
  ])
  const redisPort = container("redis:7-alpine", "6379")
  const baseUrl = `postgresql://postgres:${secrets[0]}@127.0.0.1:${pgPort}/postgres`
  const admin = new Pool({ connectionString: baseUrl })
  pools.push(admin)
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query("select 1")
      break
    } catch (error) {
      if (attempt >= 60) throw error
      await sleep(250)
    }
  }
  process.env.DATOOL_TEST_DATABASE_URL = baseUrl
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const pool = new Pool({ connectionString: target.databaseUrl, max: 4 })
  pools.push(pool)
  const port = await new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0)
      )
    })
  })
  const base = `http://127.0.0.1:${port}`
  const environment = {
    ...process.env,
    DATABASE_URL: target.databaseUrl,
    PAYLOAD_DATABASE_URL: baseUrl,
    PAYLOAD_SECRET: secrets[1],
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    BETTER_AUTH_URL: `https://localhost:${port}`,
    BETTER_AUTH_SECRET: secrets[1],
    DATOOL_API_KEY: "",
    DATOOL_PROJECT_ID: "",
    DATOOL_DIST_DIR: ".next-dashboard-release",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production" as const,
  }
  Object.assign(process.env, environment)
  const { createTracerDatabase, closeTracerDatabase } =
    await import("../src/server/tracer/db")
  const { seedEvalAttributionFacts } =
    await import("../tests/helpers/eval-attribution-fixture")
  const fixture = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
  })
  closeFixture = () => closeTracerDatabase(fixture)
  const { project } = await seedEvalAttributionFacts(fixture, 10000)
  const timestamp = new Date(Date.now() - 60000).toISOString()
  await pool.query(
    `insert into traces(project_id,id,name,operation,status,started_at,ended_at,group_type,group_name,group_version)
    select $1,'perf-trace-'||i,'Request '||i,'workflow','completed',
    to_char($2::timestamptz-(i%30)*interval '1 day'-interval '2 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char($2::timestamptz-(i%30)*interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'workflow','Workflow '||(i%100),'v'||(i%3) from generate_series(1,40000)i`,
    [project, timestamp]
  )
  await pool.query(
    `insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
    select $1,'perf-span-'||i||'-'||s,'perf-trace-'||i,'Generate '||(i%100),'llm','completed',
    to_char($2::timestamptz-(i%30)*interval '1 day'-interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char($2::timestamptz-(i%30)*interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    jsonb_build_object('cost.usd',(i%7)::float/100,'gen_ai.response.model','model-'||((i+s)%20),'gen_ai.usage.input_tokens',100,'gen_ai.usage.output_tokens',50)
    from generate_series(1,40000)i cross join generate_series(1,5)s`,
    [project, timestamp]
  )
  for (const table of [
    "traces",
    "spans",
    "trace_group_memberships",
    "eval_runs",
    "eval_run_targets",
    "eval_run_evaluators",
    "eval_results",
    "eval_target_attributions",
    "scores",
    "review_scores",
  ])
    await pool.query(`vacuum (analyze) ${table}`)
  console.info("Disposable fixture seeded; building production application.")
  await command(
    "cms-migrate",
    ["--no-env-file", "run", "cms:migrate"],
    environment
  )
  const buildStart = performance.now()
  if (process.env.DATOOL_DASHBOARD_REUSE_BUILD !== "true")
    await command("build", ["--no-env-file", "run", "build"], environment)
  report.build = {
    reused: process.env.DATOOL_DASHBOARD_REUSE_BUILD === "true",
    elapsedMs: round(performance.now() - buildStart),
  }
  const { getAuth } = await import("../lib/auth")
  const shared = await import("../lib/db")
  pools.push(shared.db, shared.analyticsDb)
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Disposable dashboard qualification",
      permissions: { traces: ["read", "write"], metrics: ["read"] },
      rateLimitMax: 1000000,
      rateLimitTimeWindow: 60000,
    },
  })
  secrets.push(credential.key)
  const headers = {
    authorization: `Bearer ${credential.key}`,
    "x-project-id": project,
    "content-type": "application/json",
  }
  const web = start(
    "web",
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    environment
  )
  start(
    "worker",
    process.execPath,
    ["--no-env-file", "run", "scripts/ingestion-worker.ts"],
    environment
  )
  for (let attempt = 0; ; attempt++) {
    assert.equal(web.exitCode, null, "Production server exited")
    try {
      const response = await fetch(`${base}/api/traces?limit=1`, {
        headers,
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) break
      if (response.status === 401 || response.status === 403)
        throw new Error("Fixture authentication failed")
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Fixture authentication failed"
      )
        throw error
    }
    assert(attempt < 90, "Production server readiness deadline exceeded")
    await sleep(250)
  }
  console.info("Production server authenticated; exercising metric reads.")
  const request = async (scenario: string, body: unknown) => {
    const start = performance.now()
    let retries = 0,
      cache: string | null = null
    const data = await retryDashboardMetricRead(async () => {
      const response = await fetch(`${base}/api/metrics/batch`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      const envelope = await response.json()
      cache = response.headers.get("X-Datool-Cache")
      if (!response.ok) {
        if (envelope.error?.code === "READ_BUSY") {
          retries++
          const retryAfter = response.headers.get("Retry-After")
          busyResponses.push({
            retryAfter,
            elapsedMs: round(performance.now() - start),
          })
          assert.equal(retryAfter, "1")
        }
        throw new DashboardRequestError(
          envelope.error?.message ?? `HTTP ${response.status}`,
          response.status,
          envelope.error?.code,
          response.headers.get("Retry-After")
        )
      }
      assert(Array.isArray(envelope.data), "Expected batch result array")
      return envelope.data as SemanticResult[]
    })
    samples.push({
      scenario,
      elapsedMs: round(performance.now() - start),
      retries,
      cache,
    })
    return data
  }
  const cost = dashboardTemplates
    .find((template) => template.id === "cost-and-usage")!
    .create()
  const costBatch = (dateFilter: string, filter = "") => {
    const rangeEnd = Date.now()
    const scope = dashboardFilterScope(dateFilter, rangeEnd, "UTC")
    const plan = dashboardQueryPlan(
      cost.widgets.map((widget) => scopedWidget(widget, { ...scope, filter })),
      {}
    )
    assert.equal(plan.batches.length, 1)
    return {
      queries: plan.batches[0],
      ...(!filter ? { cache: { dateFilter, rangeEnd } } : {}),
    }
  }
  const initial = costBatch("startedAt >= -30d")
  const first = await request("cold", initial)
  assert.equal(samples.at(-1)!.cache, "miss")
  const expectedCost = Number(
    (
      await pool.query(
        "select sum(cost_usd) as cost from spans where project_id=$1",
        [project]
      )
    ).rows[0].cost
  )
  assert(
    Math.abs(Number(first[0].data[0]["spans.costUsd"]) - expectedCost) <
      0.000001,
    "HTTP cost reconciles with persisted spans"
  )
  await Promise.all(
    Array.from({ length: 8 }, () => request("cached-8", initial))
  )
  assert(
    samples
      .filter((sample) => sample.scenario === "cached-8")
      .every((sample) => sample.cache === "fresh" && sample.retries === 0)
  )
  await Promise.all(
    Array.from({ length: 8 }, () =>
      request("cold-coalesced-8", costBatch("startedAt >= -14d"))
    )
  )
  await request("forced", {
    ...initial,
    cache: { ...initial.cache!, force: true },
  })
  const before = performance.now()
  let stopMonitor = false
  const monitor = (async () => {
    while (!stopMonitor) {
      if (writes.length) {
        const rows = await pool.query(
          "select event_id from ingestion_receipts where project_id=$1 and event_id=any($2::uuid[])",
          [project, writes.map((write) => write.eventId)]
        )
        for (const row of rows.rows) {
          const write = writes.find((write) => write.eventId === row.event_id)!
          write.persistedMs ??= round(performance.now() - before)
        }
      }
      await sleep(100)
    }
  })()
  try {
    const ingestion = (async () => {
      for (let i = 0; i < 30; i++) {
        const eventId = crypto.randomUUID(),
          started = performance.now()
        const response = await fetch(`${base}/api/ingest`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: eventId,
            previousId: null,
            path: "/api/traces",
            method: "POST",
            body: {
              id: `release-${eventId}`,
              name: "Concurrent dashboard ingestion",
              status: "completed",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
            },
          }),
          signal: AbortSignal.timeout(10000),
        })
        writes.push({
          eventId,
          status: response.status,
          acceptedMs: round(performance.now() - started),
        })
        await response.arrayBuffer()
        await sleep(200)
      }
    })()
    // Every filter is different but keeps all seeded spans, so this cannot hide behind coalescing.
    const results = await Promise.allSettled([
      ingestion,
      ...Array.from({ length: 8 }, (_, i) =>
        request(
          "filtered-8-with-ingestion",
          costBatch("startedAt >= -30d", `name != "Absent ${i}"`)
        )
      ),
    ])
    for (const result of results)
      if (result.status === "rejected") throw result.reason
    assert(
      busyResponses.length > 0,
      "Burst must exercise real READ_BUSY recovery"
    )
    for (
      let attempt = 0;
      writes.some((write) => write.persistedMs === undefined) && attempt < 100;
      attempt++
    )
      await sleep(100)
    assert.equal(writes.length, 30)
    assert(
      writes.every(
        (write) => write.status === 202 && write.persistedMs !== undefined
      ),
      "All accepted writes must commit"
    )
    const count = (
      await pool.query(
        "select count(*)::int as count from traces where project_id=$1 and id like 'release-%'",
        [project]
      )
    ).rows[0].count
    assert.equal(count, 30)
    assert(
      writes.some(
        (write) =>
          write.persistedMs! <
          Math.max(
            ...samples
              .filter(
                (sample) => sample.scenario === "filtered-8-with-ingestion"
              )
              .map((sample) => sample.elapsedMs)
          )
      ),
      "Ingestion must commit while reads run"
    )
  } finally {
    stopMonitor = true
    await monitor
  }
  // Exercise every new source over HTTP, including the definition guard required by Scores.
  const sources = [
    { measures: ["traces.count"] },
    { measures: ["spans.spanCount"] },
    { measures: ["evalRuns.count"] },
    { measures: ["evalResults.executionCount"] },
    {
      measures: ["scoreValues.count", "scoreValues.meanValue"],
      dimensions: ["scoreValues.definitionId"],
    },
  ]
  const sourceResults = await request("five-sources", {
    queries: sources.map((query) => {
      const model = query.measures[0].split(".")[0]
      const time =
        model === "evalRuns"
          ? "createdAt"
          : model === "evalResults"
            ? "completedAt"
            : model === "scoreValues"
              ? "recordedAt"
              : "startedAt"
      return {
        ...query,
        timeDimensions: [
          {
            dimension: `${model}.${time}`,
            dateRange: [
              new Date(Date.now() - 30 * 86400000).toISOString(),
              new Date().toISOString(),
            ],
          },
        ],
        limit: 1,
      }
    }),
  })
  report.sourceCounts = sourceResults.map((result) => result.data)
  assert.deepEqual(
    sourceResults.map((result, i) =>
      Number(result.data[0][sources[i].measures[0]])
    ),
    [40031, 200000, 10000, 50000, 50000]
  )
  report.status = "passed"
} catch (error) {
  report.status = "failed"
  report.error = redact(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue
    child.kill("SIGTERM")
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(3000),
    ])
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await new Promise((resolve) => child.once("exit", resolve))
    }
  }
  await closeFixture?.()
  await Promise.all(pools.map((pool) => pool.end()))
  await target?.close()
  for (const name of containers.reverse())
    execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" })
  report.samples = samples
  report.busyResponses = busyResponses
  report.writes = writes
  report.fixtureRemoved = true
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(report, null, 2) + "\n"
  )
  console.info(
    JSON.stringify({
      status: report.status,
      error: report.error,
      samples: samples.length,
      busyResponses: busyResponses.length,
      writes: writes.length,
      report: `${output}/report.json`,
    })
  )
}
