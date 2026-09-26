/** Authenticated HTTP smoke/load harness. Never treats smoke coverage as qualification. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, writeFile } from "node:fs/promises"
import { cpus, totalmem } from "node:os"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { readWorkloads } from "./read-load/workloads"
import { boundedInteger, localEndpoint } from "./read-load/safety"

if (!process.env.DATOOL_TEST_DATABASE_URL)
  throw new Error("Set an explicit disposable DATOOL_TEST_DATABASE_URL.")
localEndpoint(process.env.DATOOL_TEST_DATABASE_URL, [
  "postgres:",
  "postgresql:",
])
const count = boundedInteger(
  process.env.DATOOL_READ_TRACES,
  20_001,
  1,
  2_000_000
)
const spansPerTrace = boundedInteger(
  process.env.DATOOL_READ_SPANS_PER_TRACE,
  5,
  1,
  5
)
const clients = boundedInteger(process.env.DATOOL_READ_CLIENTS, 10, 1, 1000)
const seconds = boundedInteger(process.env.DATOOL_READ_SECONDS, 15, 1, 3600)
const arrivalRate = boundedInteger(process.env.DATOOL_READ_RATE, 10, 1, 1000)
const writeRate = boundedInteger(process.env.DATOOL_READ_WRITE_RATE, 5, 0, 100)
const settleSeed = process.env.DATOOL_READ_SETTLE_SEED === "true"
const preparation: { statement: string; durationMs: number }[] = []
const id = crypto.randomUUID(),
  started = new Date().toISOString()
const target = await createIsolatedPostgres()
const pool = new Pool({ connectionString: target.databaseUrl, max: 2 })
let web: ChildProcess | undefined,
  worker: ChildProcess | undefined,
  redisId: string | undefined,
  authPool: Pool | undefined,
  analyticsPool: Pool | undefined
const output = `artifacts/read-load/${started.replaceAll(":", "-")}.json`
const samples: {
  kind: string
  status: number
  latencyMs: number
  requestMs: number
  schedulingLagMs: number
  bytes: number
}[] = []
const accepted: string[] = [],
  committed = new Set<string>()
let peakWebRssKiB = 0
let offered = 0,
  clientBusy = 0,
  maxInFlight = 0,
  inFlight = 0
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0)
      )
    })
  })
const stop = async (child: ChildProcess | undefined) => {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000),
  ])
  if (child.exitCode === null) child.kill("SIGKILL")
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null
}
const databaseCounters = async () => ({
  capturedAt: new Date().toISOString(),
  checkpointer: (await pool.query("select * from pg_stat_checkpointer"))
    .rows[0],
  database: (
    await pool.query(
      "select blks_read,blks_hit,temp_files,temp_bytes,deadlocks from pg_stat_database where datname=current_database()"
    )
  ).rows[0],
  activeMaintenance: (
    await pool.query(
      "select backend_type,wait_event_type,wait_event from pg_stat_activity where backend_type in ('autovacuum worker','checkpointer')"
    )
  ).rows,
})
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  console.info(
    JSON.stringify({
      event: "seed",
      traces: count,
      spans: count * spansPerTrace,
    })
  )
  await pool.query(
    `insert into traces(project_id,id,name,operation,status,started_at,ended_at,group_type,group_name,group_version,attributes_json)
    select $1,'retained-'||i,'Retained','load','completed',to_char(timestamp '2026-09-01'+(i%30)*interval '1 day','YYYY-MM-DD"T"HH24:MI:SS"Z"'),to_char(timestamp '2026-09-01'+(i%30)*interval '1 day'+interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),case when i%2=0 then 'workflow' else 'agent' end,'Group '||((i/2)%1000),'v'||(i%3),jsonb_build_object('customer','customer-'||(i%10000),'cost.usd',0.01) from generate_series(1,$2::integer)i`,
    [target.projectId, count]
  )
  await pool.query(
    `insert into spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
    select $1,'span-'||i||'-'||s,'retained-'||i,'Model','llm','completed','2026-09-01T00:00:00Z','2026-09-01T00:00:01Z','{"cost.usd":0.01}' from generate_series(1,$2::integer)i cross join generate_series(1,$3::integer)s`,
    [target.projectId, count, spansPerTrace]
  )
  await pool.query("analyze traces")
  await pool.query("analyze spans")
  await pool.query("analyze trace_group_memberships")
  await pool.query("analyze invocation_hourly_stats")
  if (settleSeed) {
    for (const statement of [
      "vacuum (analyze) traces",
      "vacuum (analyze) spans",
      "vacuum (analyze) trace_group_memberships",
      "vacuum (analyze) invocation_hourly_stats",
      "checkpoint",
    ]) {
      const started = performance.now()
      await pool.query(statement)
      const step = { statement, durationMs: performance.now() - started }
      preparation.push(step)
      console.info(JSON.stringify({ event: "prepare", ...step }))
    }
  }
  const port = await freePort(),
    base = `http://127.0.0.1:${port}`
  redisId = execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      `datool-read-${id}`,
      "--label",
      `datool.read-load=${id}`,
      "-p",
      "127.0.0.1::6379",
      "redis:7-alpine",
    ],
    { encoding: "utf8" }
  ).trim()
  const redisPort = execFileSync("docker", ["port", redisId, "6379/tcp"], {
    encoding: "utf8",
  })
    .trim()
    .split(":")
    .at(-1)
  const environment = {
    ...process.env,
    DATABASE_URL: target.databaseUrl,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    BETTER_AUTH_URL: `https://localhost:${port}`,
    BETTER_AUTH_SECRET: `local-read-load-${id}`,
    DATOOL_DIST_DIR: ".next-read-capacity",
    NODE_ENV: "production" as const,
  }
  Object.assign(process.env, {
    DATABASE_URL: environment.DATABASE_URL,
    BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
  })
  const { getAuth } = await import("../lib/auth")
  const pools = await import("../lib/db")
  authPool = pools.db
  analyticsPool = pools.analyticsDb
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Disposable read load",
      permissions: { traces: ["read", "write"], metrics: ["read"] },
      rateLimitMax: 1_000_000,
      rateLimitTimeWindow: 60_000,
    },
  })
  // Child output is suppressed: reports contain neither credentials nor request payloads.
  web = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { env: environment, stdio: "ignore" }
  )
  worker = spawn(process.execPath, ["run", "scripts/ingestion-worker.ts"], {
    env: environment,
    stdio: "ignore",
  })
  const headers = {
    authorization: `Bearer ${credential.key}`,
    "x-project-id": target.projectId,
    "content-type": "application/json",
  }
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (web?.exitCode !== null)
      throw new Error(
        "Owned production server exited before readiness. Build .next-read-capacity first."
      )
    try {
      const response = await fetch(`${base}/api/traces?limit=1`, {
        headers,
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        ready = true
        break
      }
      if (response.status === 401 || response.status === 403)
        throw new Error("Fixture authentication failed.")
    } catch {
      /* A failed local readiness probe or transport is recorded by the caller. */
    }
    await sleep(250)
  }
  if (!ready)
    throw new Error(
      "Owned server did not become ready with fixture authentication."
    )
  const baseline: {
    kind: string
    repetition: number
    status: number
    latencyMs: number
    bytes: number
    result: unknown
  }[] = []
  for (const workload of readWorkloads) {
    for (let repetition = 0; repetition < 3; repetition++) {
      const before = performance.now()
      let status = 0,
        bytes = 0,
        result: unknown = null
      try {
        const response = await fetch(`${base}${workload.path}`, {
          headers,
          signal: AbortSignal.timeout(25_000),
          ...(workload.body
            ? { method: "POST", body: JSON.stringify(workload.body) }
            : {}),
        })
        status = response.status
        const body = await response.text()
        bytes = Buffer.byteLength(body)
        try {
          result = JSON.parse(body)
        } catch {
          result = "Non-JSON response"
        }
      } catch {
        result = "Transport failure or deadline exceeded"
      }
      baseline.push({
        kind: workload.kind,
        repetition,
        status,
        latencyMs: performance.now() - before,
        bytes,
        result,
      })
      console.info(
        JSON.stringify({
          event: "baseline",
          ...baseline.at(-1),
          result: undefined,
        })
      )
    }
  }
  const work = new Set<Promise<void>>()
  const countersBefore = await databaseCounters()
  const origin = performance.now()
  async function send(kind: string, due: number) {
    const isWrite = kind === "ingest"
    const workload = readWorkloads.find((item) => item.kind === kind)
    const requestStarted = performance.now()
    const eventId = crypto.randomUUID()
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    let status = 0,
      bytes = 0
    try {
      const response = await fetch(
        `${base}${isWrite ? "/api/ingest" : workload!.path}`,
        {
          headers,
          signal: AbortSignal.timeout(20_000),
          ...(!isWrite && !workload?.body
            ? {}
            : {
                method: "POST",
                body: JSON.stringify(
                  isWrite
                    ? {
                        id: eventId,
                        previousId: null,
                        path: "/api/traces",
                        method: "POST",
                        body: {
                          id: `load-${eventId}`,
                          name: "Concurrent ingestion",
                          status: "completed",
                          startedAt: "2026-09-01T00:00:00Z",
                          endedAt: "2026-09-01T00:00:01Z",
                        },
                      }
                    : workload!.body
                ),
              }),
        }
      )
      status = response.status
      const body = await response.text()
      bytes = Buffer.byteLength(body)
      if (isWrite && status === 202) accepted.push(eventId)
    } catch {
      /* Transport failures are recorded with status zero. */
    } finally {
      samples.push({
        kind,
        status,
        bytes,
        latencyMs: performance.now() - origin - due,
        requestMs: performance.now() - requestStarted,
        schedulingLagMs: requestStarted - origin - due,
      })
      inFlight--
    }
  }
  const schedule = (kind: string, due: number) => {
    offered++
    if (inFlight >= clients) {
      clientBusy++
      return
    }
    const promise = send(kind, due).finally(() => work.delete(promise))
    work.add(promise)
  }
  console.info(
    JSON.stringify({ event: "load", clients, seconds, arrivalRate, writeRate })
  )
  let nextMemorySample = 0
  let nextRead = 0,
    nextWrite = 0,
    lastProgress = 0
  while (performance.now() - origin < seconds * 1000) {
    const elapsed = performance.now() - origin
    if (elapsed >= nextMemorySample && web.pid) {
      nextMemorySample = elapsed + 1000
      try {
        peakWebRssKiB = Math.max(
          peakWebRssKiB,
          Number(
            execFileSync("ps", ["-o", "rss=", "-p", String(web.pid)], {
              encoding: "utf8",
            }).trim()
          )
        )
      } catch {
        /* The owned process may already have exited. */
      }
    }
    while (nextRead <= elapsed) {
      schedule(
        readWorkloads.map((item) => item.kind)[
          Math.floor((nextRead * arrivalRate) / 1000) % readWorkloads.length
        ],
        nextRead
      )
      nextRead += 1000 / arrivalRate
    }
    while (writeRate && nextWrite <= elapsed) {
      schedule("ingest", nextWrite)
      nextWrite += 1000 / writeRate
    }
    if (elapsed - lastProgress >= 30_000) {
      lastProgress = elapsed
      console.info(
        JSON.stringify({
          event: "progress",
          elapsedSeconds: Math.round(elapsed / 1000),
          offered,
          completed: samples.length,
          inFlight,
        })
      )
    }
    await sleep(5)
  }
  await Promise.all(work)
  const countersAfter = await databaseCounters()
  for (let i = 0; i < 120; i++) {
    const receipts = await pool.query(
      "select event_id from ingestion_receipts where project_id=$1 and event_id=any($2::uuid[])",
      [target.projectId, accepted]
    )
    for (const row of receipts.rows) committed.add(row.event_id)
    if (committed.size === accepted.length) break
    await sleep(250)
  }
  const summary = Object.fromEntries(
    [...readWorkloads.map((item) => item.kind), "ingest"].map((kind) => {
      const rows = samples.filter((s) => s.kind === kind),
        ok = rows.filter((s) => s.status >= 200 && s.status < 300)
      return [
        kind,
        {
          completed: rows.length,
          succeeded: ok.length,
          statuses: Object.fromEntries(
            [...new Set(rows.map((s) => s.status))].map((status) => [
              status,
              rows.filter((s) => s.status === status).length,
            ])
          ),
          p50: percentile(
            rows.map((s) => s.latencyMs),
            0.5
          ),
          p95: percentile(
            rows.map((s) => s.latencyMs),
            0.95
          ),
          p99: percentile(
            rows.map((s) => s.latencyMs),
            0.99
          ),
          successfulRequestP95: percentile(
            ok.map((s) => s.requestMs),
            0.95
          ),
          schedulingLagP95: percentile(
            rows.map((s) => s.schedulingLagMs),
            0.95
          ),
          maxBytes: Math.max(0, ...rows.map((s) => s.bytes)),
        },
      ]
    })
  )
  const profiles =
    process.env.DATOOL_READ_PROFILE === "true"
      ? await (await import("./read-load/profile")).profileReads(target, pool)
      : undefined
  const report = {
    schemaVersion: 1,
    started,
    source: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirtyFiles: execFileSync("git", ["diff", "--name-only"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    scope: "authenticated production HTTP local mixed-read benchmark",
    coverage: {
      registeredUsers: 1,
      projects: 1,
      traces: count,
      spans: count * spansPerTrace,
      evalRuns: 0,
      evalResults: 0,
      clients,
      seconds,
      arrivalRate,
      writeRate,
      mixedModelDashboard: true,
      duplicateQueryDashboard: false,
    },
    offered,
    clientBusy,
    maxInFlight,
    peakWebRssKiB,
    acceptedIngestion: accepted.length,
    committedIngestion: committed.size,
    summary,
    samples,
    baseline,
    profiles,
    databasePreparation: { settleSeed, steps: preparation },
    databaseCounters: { before: countersBefore, after: countersAfter },
    qualification: false,
    missingQualificationEvidence: [
      "1000 identities and dispersed tenancy",
      "eval retained population",
      "30-minute steady-state plus burst and drain",
      "DB CPU/temp spill and server event-loop telemetry",
      ...(profiles ? [] : ["actual compiled EXPLAIN plans"]),
      "cross-tenant HTTP assertions",
    ],
  }
  await mkdir("artifacts/read-load", { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2))
  console.info(
    JSON.stringify({
      event: "report",
      output,
      summary,
      accepted: accepted.length,
      committed: committed.size,
      qualification: false,
    })
  )
} finally {
  await stop(web)
  await stop(worker)
  if (redisId) execFileSync("docker", ["stop", redisId], { stdio: "ignore" })
  await authPool?.end()
  await analyticsPool?.end()
  await pool.end()
  await target.close()
}
