import { mkdir, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { fetchWithRetry } from "../src/lib/tracer/retry"

const dockerProject = process.env.DATOOL_LOAD_PROJECT ?? "datool-load"
if (!/^datool-load(?:-[a-z0-9]+)?$/.test(dockerProject))
  throw new Error("Dedicated datool-load project name required")
for (const key of [
  "DATOOL_LOAD_BASE_URL",
  "DATOOL_LOAD_DATABASE_URL",
  "DATOOL_LOAD_REDIS_URL",
  "DATOOL_LOAD_AUTH",
])
  if (process.env[key])
    throw new Error(
      `${key} is obsolete; endpoints come from the dedicated Compose stack and authentication always uses an organization key.`
    )
const selected = process.argv[2]
const phaseNames = [
  "baseline",
  "burst",
  "large-payload",
  "worker-crash",
  "database-outage",
  "redis-outage",
]
if (selected && !phaseNames.includes(selected))
  throw new Error(`Unknown phase: ${selected}`)
const keyLimit = positiveInteger("DATOOL_LOAD_KEY_LIMIT", 100000)
const keyWindow = positiveInteger("DATOOL_LOAD_KEY_WINDOW_MS", 60000)
function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}
const execute = promisify(execFile)
const dockerEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ...Object.fromEntries(
    [
      "PATH",
      "HOME",
      "DATOOL_LOAD_IMAGE",
      "DATOOL_LOAD_HTTP_PORT",
      "DATOOL_LOAD_POSTGRES_PORT",
      "DATOOL_LOAD_REDIS_PORT",
    ].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]]
    )
  ),
}
const docker = async (args: string[]) =>
  (
    await execute(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "-p",
        dockerProject,
        "-f",
        "compose.load.yaml",
        ...args,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: dockerEnv,
        maxBuffer: 1024 * 1024,
      }
    )
  ).stdout.trim()
// Check ownership before connecting, seeding, or interrupting any service.
for (const service of ["app", "worker", "postgres", "redis"]) {
  const id = await docker(["ps", "-q", service])
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error(`Start the dedicated load stack first: missing ${service}`)
  const { stdout } = await execute("docker", ["inspect", id], {
    env: dockerEnv,
  })
  const [container] = JSON.parse(stdout) as {
    Config: { Labels: Record<string, string> }
    HostConfig: { PortBindings: Record<string, { HostPort: string }[] | null> }
  }[]
  if (container.Config.Labels["io.datool.fixture"] !== "ingestion-load")
    throw new Error(`Refusing ${service}: not an ingestion-load fixture`)
  if (
    Object.values(container.HostConfig.PortBindings ?? {}).some((bindings) =>
      bindings?.some((binding) => !binding.HostPort || binding.HostPort === "0")
    )
  )
    throw new Error(
      `${service} needs a fixed host port; Docker reassigns random ports during outage tests`
    )
}
async function endpoint(service: string, port: number) {
  const address = await docker(["port", service, String(port)])
  if (!/^127\.0\.0\.1:[1-9][0-9]*$/.test(address))
    throw new Error(`${service} must publish exactly one loopback port`)
  return address
}
const [httpAddress, postgresAddress, redisAddress] = await Promise.all([
  endpoint("app", 3000),
  endpoint("postgres", 5432),
  endpoint("redis", 6379),
])
const baseUrl = `http://${httpAddress}`
const databaseUrl = `postgresql://datool:load-fixture@${postgresAddress}/datool`
const projectId = "datool-load-project"
const pool = new Pool({ connectionString: databaseUrl, max: 2 })
pool.on("error", () => {})
const redis = new Redis(`redis://${redisAddress}`, { maxRetriesPerRequest: 1 })
redis.on("error", () => {})
let apiKey: string
let generatedKeyId: string | undefined
const run = new Date().toISOString().replace(/[:.]/g, "-")
const output = `artifacts/load-tests/${run}.json`
const report: { run: string; mode: string; phases: unknown[] } = {
  run,
  mode: "production Next.js; one ingestion worker; local Docker; organization key",
  phases: [],
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function checkpoint() {
  await mkdir("artifacts/load-tests", { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2))
}
async function seed() {
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('load-user','Load test','load@localhost.test',false,now(),now()) ON CONFLICT DO NOTHING`
  )
  await pool.query(
    `INSERT INTO organization (id,name,slug,"createdAt") VALUES ('load-org','Load test','load-test',now()) ON CONFLICT DO NOTHING`
  )
  await pool.query(
    `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('load-member','load-org','load-user','owner',now()) ON CONFLICT DO NOTHING`
  )
  await pool.query(
    `INSERT INTO project (id,organization_id,name,slug,created_at,updated_at) VALUES ($1,'load-org','Load test','load-test',now(),now()) ON CONFLICT DO NOTHING`,
    [projectId]
  )
}
type Phase = {
  name: string
  traces: number
  spans: number
  producers: number
  bytes: number
  interrupt?: "worker" | "postgres" | "redis"
  duplicateEvery?: number
}
type Event = {
  id: string
  previousId: string | null
  path: string
  method: string
  body: Record<string, unknown>
}
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * p) - 1)
  ] ?? 0
async function phase(config: Phase) {
  console.info(JSON.stringify({ event: "phase_start", ...config }))
  const phaseId = `${run}-${config.name}`
  const started = performance.now()
  const ids: string[] = [],
    latencies: number[] = []
  const accepted = new Set<string>()
  const sentAt = new Map<string, number>()
  const payload = "x".repeat(config.bytes)
  let nextTrace = 0,
    attempts = 0,
    duplicateRequests = 0,
    terminalErrors = 0,
    bytes = 0
  const statuses: Record<string, number> = {}
  let interruption: Promise<void> | undefined
  const fetchImpl: typeof fetch = async (input, init) => {
    attempts++
    try {
      const response = await fetch(input, init)
      statuses[String(response.status)] =
        (statuses[String(response.status)] ?? 0) + 1
      return response
    } catch (error) {
      statuses.transport = (statuses.transport ?? 0) + 1
      throw error
    }
  }
  async function send(event: Event, duplicate = false) {
    const body = JSON.stringify(event)
    const begin = performance.now()
    if (!duplicate) {
      ids.push(event.id)
      sentAt.set(event.id, Date.now())
      bytes += Buffer.byteLength(body)
    }
    try {
      const response = await fetchWithRetry(
        fetchImpl,
        `${baseUrl}/api/ingest`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "x-project-id": projectId,
            "content-type": "application/json",
          },
          body,
        },
        { timeoutMs: 5000 }
      )
      if (response.status !== 202) throw new Error(`HTTP ${response.status}`)
      const ack = await response.json()
      if (ack.data?.eventId !== event.id)
        throw new Error("Incorrect acknowledgement")
      accepted.add(event.id)
      latencies.push(performance.now() - begin)
    } catch {
      terminalErrors++
    }
    if (!interruption && config.interrupt && accepted.size >= 30) {
      interruption = (async () => {
        console.info(
          JSON.stringify({ event: "interrupt", service: config.interrupt })
        )
        await docker(["kill", "-s", "SIGKILL", config.interrupt!])
        await sleep(4000)
        await docker(["start", config.interrupt!])
        if (config.interrupt === "postgres") {
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              await pool.query("select 1")
              break
            } catch {
              await sleep(500)
            }
          }
        }
        console.info(
          JSON.stringify({ event: "restart", service: config.interrupt })
        )
      })()
    }
  }
  await Promise.all(
    Array.from({ length: config.producers }, async () => {
      let previousId: string | null = null
      const emit = async (
        path: string,
        method: string,
        body: Record<string, unknown>
      ) => {
        const event = {
          id: crypto.randomUUID(),
          previousId,
          path,
          method,
          body,
        }
        previousId = event.id
        const ordinal = ids.length + 1
        await send(event)
        if (config.duplicateEvery && ordinal % config.duplicateEvery === 0) {
          duplicateRequests++
          await send(event, true)
        }
      }
      while (nextTrace < config.traces) {
        const index = nextTrace++
        const traceId = `${phaseId}-${index}`
        await emit("/api/traces", "POST", {
          id: traceId,
          name: config.name,
          startedAt: "2026-09-09T00:00:00Z",
          status: "running",
          input: { payload, index },
        })
        for (let span = 0; span < config.spans; span++) {
          const id = `${traceId}-s${span}`
          await emit(`/api/traces/${traceId}/spans`, "POST", {
            id,
            name: "load span",
            kind: "llm",
            startedAt: "2026-09-09T00:00:00Z",
            status: "running",
            input: { payload, index },
          })
          await emit(`/api/spans/${id}`, "PATCH", {
            status: "completed",
            endedAt: "2026-09-09T00:00:01Z",
            output: { payload, index },
          })
        }
        await emit(`/api/traces/${traceId}`, "PATCH", {
          status: "completed",
          endedAt: "2026-09-09T00:00:01Z",
          output: { payload, index },
        })
      }
    })
  )
  await interruption
  const acceptedAt = performance.now()
  let saved = 0,
    lastPrint = 0
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const result = await pool.query(
      "select count(*)::integer as count from ingestion_receipts where project_id=$1 and event_id=any($2::uuid[])",
      [projectId, ids]
    )
    saved = result.rows[0].count
    if (saved === ids.length) break
    if (Date.now() - lastPrint > 10000) {
      console.info(
        JSON.stringify({
          event: "draining",
          phase: config.name,
          saved,
          expected: ids.length,
        })
      )
      lastPrint = Date.now()
    }
    await sleep(500)
  }
  const finished = performance.now()
  const counts = await pool.query(
    `select count(*)::integer as traces, count(*) filter (where status='completed')::integer as completed, count(*) filter (where output_json is not null and (output_json::jsonb->>'payload')=$3)::integer as outputs from traces where project_id=$1 and id like $2`,
    [projectId, `${phaseId}-%`, payload]
  )
  const spans = await pool.query(
    `select count(*)::integer as spans, count(*) filter (where status='completed')::integer as completed, count(*) filter (where output_json is not null and (output_json::jsonb->>'payload')=$3)::integer as outputs from spans where project_id=$1 and trace_id like $2`,
    [projectId, `${phaseId}-%`, payload]
  )
  const receiptRows = await pool.query(
    "select event_id, saved_at from ingestion_receipts where project_id=$1 and event_id=any($2::uuid[])",
    [projectId, ids]
  )
  const commitLatencies = receiptRows.rows.map((row) =>
    Math.max(0, new Date(row.saved_at).getTime() - sentAt.get(row.event_id)!)
  )
  const failedJobs = await redis.zcard("bull:datool-ingestion:failed")
  const memory = await redis.info("memory")
  const result = {
    ...config,
    generated: ids.length,
    accepted: accepted.size,
    saved,
    attempts,
    duplicateRequests,
    terminalErrors,
    statuses,
    payloadMB: +(bytes / 1e6).toFixed(2),
    sendSeconds: +((acceptedAt - started) / 1000).toFixed(2),
    totalSeconds: +((finished - started) / 1000).toFixed(2),
    acceptedPerSecond: +(
      accepted.size /
      ((acceptedAt - started) / 1000)
    ).toFixed(1),
    savedPerSecond: +(saved / ((finished - started) / 1000)).toFixed(1),
    acknowledgementMs: {
      p50: +percentile(latencies, 0.5).toFixed(1),
      p95: +percentile(latencies, 0.95).toFixed(1),
      p99: +percentile(latencies, 0.99).toFixed(1),
    },
    commitLatencyMs: {
      p50: percentile(commitLatencies, 0.5),
      p95: percentile(commitLatencies, 0.95),
      p99: percentile(commitLatencies, 0.99),
    },
    failedJobs,
    withinFlushWindow: finished - acceptedAt <= 60000,
    traceCounts: counts.rows[0],
    spanCounts: spans.rows[0],
    redisUsedMemoryMB: +(
      Number(/used_memory:(\d+)/.exec(memory)?.[1] ?? 0) / 1e6
    ).toFixed(2),
    pass:
      failedJobs === 0 &&
      terminalErrors === 0 &&
      saved === ids.length &&
      counts.rows[0].completed === config.traces &&
      counts.rows[0].outputs === config.traces &&
      spans.rows[0].completed === config.traces * config.spans &&
      spans.rows[0].outputs === config.traces * config.spans,
  }
  report.phases.push(result)
  await checkpoint()
  console.info(JSON.stringify({ event: "phase_result", ...result }))
}
try {
  await seed()
  // Mint inside the fixture container, using precisely its auth configuration.
  // The raw key stays in this process and is never written to the report.
  const credential = JSON.parse(
    await docker([
      "exec",
      "-T",
      "-e",
      `DATOOL_LOAD_KEY_LIMIT=${keyLimit}`,
      "-e",
      `DATOOL_LOAD_KEY_WINDOW_MS=${keyWindow}`,
      "app",
      "bun",
      "--no-env-file",
      "-e",
      `
      const { getAuth } = await import("./lib/auth.ts");
      const { db, analyticsDb } = await import("./lib/db.ts");
      try {
        const key = await getAuth().api.createApiKey({ body: {
          organizationId: "load-org", userId: "load-user", name: "Disposable ingestion load test",
          permissions: { traces: ["write"] },
          rateLimitMax: Number(process.env.DATOOL_LOAD_KEY_LIMIT),
          rateLimitTimeWindow: Number(process.env.DATOOL_LOAD_KEY_WINDOW_MS),
        } });
        console.log(JSON.stringify({ id: key.id, key: key.key }));
      } finally { await db.end(); await analyticsDb.end(); }
    `,
    ])
  ) as { id: string; key: string }
  generatedKeyId = credential.id
  apiKey = credential.key
  const phases: Phase[] = [
    { name: "baseline", traces: 100, spans: 4, producers: 4, bytes: 256 },
    {
      name: "burst",
      traces: 500,
      spans: 8,
      producers: 32,
      bytes: 1024,
      duplicateEvery: 20,
    },
    {
      name: "large-payload",
      traces: 100,
      spans: 4,
      producers: 16,
      bytes: 32768,
    },
    {
      name: "worker-crash",
      traces: 100,
      spans: 4,
      producers: 8,
      bytes: 1024,
      interrupt: "worker",
    },
    {
      name: "database-outage",
      traces: 100,
      spans: 4,
      producers: 8,
      bytes: 1024,
      interrupt: "postgres",
    },
    {
      name: "redis-outage",
      traces: 100,
      spans: 4,
      producers: 8,
      bytes: 1024,
      interrupt: "redis",
    },
  ]
  const chosen = phases.filter((p) => !selected || p.name === selected)
  if (!chosen.length) throw new Error(`Unknown phase: ${selected}`)
  for (const config of chosen) await phase(config)
  if (report.phases.some((p) => !(p as { pass: boolean }).pass))
    process.exitCode = 1
  console.info(JSON.stringify({ event: "report", output }))
} finally {
  try {
    if (generatedKeyId)
      await pool.query("delete from apikey where id=$1", [generatedKeyId])
  } finally {
    await pool.end()
    await redis.quit().catch(() => redis.disconnect())
    await checkpoint()
  }
}
