/** Local-only comparison of real authenticated route handlers, PostgreSQL and Redis.
 * Uses the same HTTP adapter as ingestion integration tests, not Next's runtime.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { Pool, type PoolClient } from "pg"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "../tests/helpers/postgres"
import { localEndpoint, boundedInteger } from "./read-load/safety"
import { serveWebhook } from "../src/server/apps/webhook"

localEndpoint(process.env.DATOOL_TEST_DATABASE_URL ?? "", ["postgres:", "postgresql:"])
localEndpoint(process.env.DATOOL_TEST_REDIS_URL ?? "", ["redis:"])
const rounds = boundedInteger(process.env.COMPARE_ROUNDS, 6, 2, 30)
const viewers = boundedInteger(process.env.COMPARE_VIEWERS, 12, 2, 50)
const traces = boundedInteger(process.env.COMPARE_TRACES, 10_000, 100, 100_000)
const target = await createIsolatedPostgres()
const seed = new Pool({ connectionString: target.databaseUrl })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const percentile = (values: number[], fraction: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * fraction)-1)] ?? 0
const output = `artifacts/trace-refresh/${new Date().toISOString().replaceAll(":", "-")}.json`
let server: Awaited<ReturnType<typeof serveWebhook>> | undefined
let pools: typeof import("../lib/db") | undefined
let stopWriter = false
let writer: Promise<void> | undefined
const counters = { sql: 0, traceSql: 0, revisionSql: 0 }
let counting = false
const results: unknown[] = []
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  await seed.query(`INSERT INTO traces(project_id,id,name,operation,status,started_at,ended_at,input_json,output_json,attributes_json)
    SELECT $1,'trace-'||i,'Trace '||i,'comparison','completed',to_char(now() - (i * interval '1 second'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),jsonb_build_object('prompt',repeat('x',512)),jsonb_build_object('answer',repeat('y',2048)),'{}'
    FROM generate_series(1,$2::integer)i`, [target.projectId, traces])
  await seed.query(`INSERT INTO spans(project_id,id,trace_id,name,kind,status,started_at,ended_at,attributes_json)
    SELECT $1,'span-'||i||'-'||s,'trace-'||i,'Model','llm','completed',to_char(now() - interval '1 second','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'{"cost.usd":0.01,"usage.input_tokens":100}'
    FROM generate_series(1,$2::integer)i CROSS JOIN generate_series(1,5)s`, [target.projectId, traces])
  for (const table of ['traces','spans','trace_group_memberships','trace_read_revisions']) await seed.query(`VACUUM (ANALYZE) ${table}`)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl, REDIS_URL: process.env.DATOOL_TEST_REDIS_URL,
    BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: `comparison-${crypto.randomUUID()}`,
    DATOOL_BILLING_ENABLED: "false",
  })
  const { getAuth } = await import("../lib/auth")
  pools = await import("../lib/db")
  const instrument = (client: PoolClient) => {
    const original = client.query
    client.query = function(...args: unknown[]) {
      const first = args[0] as string | { text?: string }
      const text = typeof first === "string" ? first : first.text ?? ""
      if (counting) {
        counters.sql++
        if (/^\s*(select|with)\b/i.test(text) && /\b(traces|spans|scores|review_scores)\b/i.test(text)) counters.traceSql++
        if (/FROM trace_read_revisions WHERE project_id/.test(text)) counters.revisionSql++
      }
      return (original as (...args: unknown[]) => unknown).apply(client, args)
    } as typeof client.query
  }
  // Include authorization and transaction control overhead in all-SQL counts.
  // Existing auth connection also needs instrumentation.
  pools.db.on("connect", instrument); pools.analyticsDb.on("connect", instrument)
  const credential = await getAuth().api.createApiKey({ body: {
    organizationId: target.organizationId, userId: target.ownerId, name: "Disposable refresh comparison",
    permissions: { traces: ["read", "write"] }, rateLimitMax: 1_000_000, rateLimitTimeWindow: 60_000,
  } })
  const list = await import("../app/api/traces/route")
  const overview = await import("../app/api/traces/[id]/overview/route")
  const scores = await import("../app/api/traces/[id]/scores/route")
  server = await serveWebhook(async request => {
    const path = new URL(request.url).pathname
    if (path === "/api/traces") return list.GET(request)
    const context = { params: Promise.resolve({ id: "trace-1" }) }
    if (path.endsWith("/overview")) return overview.GET(request, context)
    if (path.endsWith("/scores")) return scores.GET(request, context)
    return new Response(null, { status: 404 })
  })
  const origin = `http://127.0.0.1:${server.port}`
  const headers = { authorization: `Bearer ${credential.key}`, "x-project-id": target.projectId }
  const paths = ["/api/traces?limit=50&includeTotal=false", "/api/traces/trace-1/overview", "/api/traces/trace-1/scores?limit=50&includeTotal=false"]
  // Warm code, auth, connections and PostgreSQL pages equally before measurement.
  process.env.DATOOL_TRACE_READ_CACHE = "off"
  for (let i=0; i<3; i++) for (const path of paths) {
    const response = await fetch(origin+path, { headers })
    if (!response.ok) throw new Error(`Warmup failed ${response.status}: ${await response.text()}`)
    await response.text()
  }
  const scenarios = [{ name: "quiet", active: false, clients: viewers }, { name: "active-one-viewer", active: true, clients: 1 }, { name: "active-many-viewers", active: true, clients: viewers }]
  for (const scenario of scenarios) {
    // Reverse mode order for the middle workload to reduce systematic warmup bias.
    const modes = scenario.clients === 1 ? ["combined","shared","version","off"] : ["off","version","shared","combined"]
    for (const mode of modes) {
      process.env.DATOOL_TRACE_READ_CACHE = mode
      await sleep(2100)
      const nonce = crypto.randomUUID()
      const urls = paths.map(path => origin+path+(path.includes("?") ? "&" : "?")+`comparison=${nonce}`)
      const clients = Array.from({ length: scenario.clients }, () => new Map<string,string>())
      let writes = 0, bytes = 0, requests = 0, unchanged = 0, errors = 0, full = 0
      const latency: number[] = [], writeLatency: number[] = []
      const cacheStates: Record<string,number> = {}
      Object.assign(counters, { sql: 0, traceSql: 0, revisionSql: 0 })
      stopWriter = false
      writer = scenario.active ? (async () => {
        while (!stopWriter) {
          const started = performance.now()
          await seed.query("UPDATE traces SET name=$1 WHERE project_id=$2 AND id='trace-1'", [`Updated ${String(++writes).padStart(6,'0')}`,target.projectId])
          writeLatency.push(performance.now()-started)
          await sleep(Math.max(0,250-(performance.now()-started)))
        }
      })() : undefined
      const started = performance.now()
      counting = true
      for (let round=0; round<rounds; round++) {
        await sleep(Math.max(0, started + round*3000 - performance.now()))
        await Promise.all(clients.map(async (tags, index) => {
          // Deterministic spread across one second, representative of separate tabs.
          await sleep(index * 1000 / scenario.clients)
          await Promise.all(urls.map(async url => {
            const before = performance.now()
            const response = await fetch(url, { headers: { ...headers, ...(tags.has(url) ? { "if-none-match": tags.get(url)! } : {}) }, signal: AbortSignal.timeout(20_000) })
            const text = await response.text()
            latency.push(performance.now()-before); requests++; bytes += Buffer.byteLength(text)
            const state = response.headers.get("x-datool-cache") ?? "none"
            cacheStates[state] = (cacheStates[state] ?? 0)+1
            if (response.status===304) unchanged++
            else if (response.ok) { full++; JSON.parse(text) }
            else errors++
            const etag=response.headers.get("etag")
            if (etag) tags.set(url,etag); else tags.delete(url)
          }))
        }))
      }
      counting = false
      stopWriter=true; await writer; writer=undefined
      let settledUpdateMs: number | null = null
      if (scenario.active) {
        const expected = (await seed.query("SELECT name FROM traces WHERE id='trace-1'")).rows[0].name
        const startedCheck = performance.now()
        for (;;) {
          const responses = await Promise.all(urls.slice(0,2).map(async url => {
            const response = await fetch(url, { headers })
            if (!response.ok) throw new Error("Freshness verification failed")
            const data = (await response.json()).data
            return Array.isArray(data.items) ? data.items.find((item: { id:string }) => item.id==='trace-1')?.name : data.name
          }))
          if (responses.every(name => name===expected)) { settledUpdateMs=performance.now()-startedCheck; break }
          if (performance.now()-startedCheck>3500) throw new Error("Committed update remained stale beyond cache window")
          await sleep(100)
        }
      }
      const result = { scenario: scenario.name, mode, viewers: scenario.clients, rounds, requests, full, unchanged, errors, bytes,
        ...counters, p50Ms: percentile(latency,0.5), p95Ms: percentile(latency,0.95), elapsedMs: performance.now()-started,
        writes, settledUpdateMs, writeP95Ms: percentile(writeLatency,0.95), cacheStates }
      results.push(result)
      console.info(JSON.stringify(result))
      if (errors) throw new Error("Comparison had HTTP failures")
    }
  }
  // Verify a warm cache cannot bypass auth or cross project boundaries.
  process.env.DATOOL_TRACE_READ_CACHE="combined"
  const warm = await fetch(origin+paths[0], { headers }); const tag = warm.headers.get("etag")!
  const denied = await fetch(origin+paths[0], { headers: { "x-project-id":target.projectId, "if-none-match":tag } })
  const wrongProject = await fetch(origin+paths[0], { headers: { ...headers, "x-project-id":crypto.randomUUID(), "if-none-match":tag } })
  if (![401,403].includes(denied.status) || wrongProject.ok || wrongProject.status===304) throw new Error("Cache authorization failed")
  const force = await fetch(origin+paths[0], { headers: { ...headers, "if-none-match":tag, "x-datool-refresh":"force" } })
  if (force.status!==200 || force.headers.get("x-datool-cache")!=="bypass") throw new Error("Explicit refresh did not bypass")
  // Measure write overhead separately, alternating trigger enablement and using
  // identical UPDATE statements; only our triggers change in the disposable schema.
  const writeComparison: { enabled: boolean; p50Ms:number; p95Ms:number; totalMs:number }[]=[]
  for (const enabled of [false,true,true,false]) {
    for (const name of ["trace_read_insert","trace_read_update","trace_read_delete"]) await seed.query(`ALTER TABLE traces ${enabled ? "ENABLE" : "DISABLE"} TRIGGER ${name}`)
    const times:number[]=[]
    for(let i=0;i<100;i++) { const start=performance.now(); await seed.query("UPDATE traces SET name=$1 WHERE project_id=$2 AND id='trace-1'", [`Write ${i}`,target.projectId]); times.push(performance.now()-start) }
    writeComparison.push({ enabled,p50Ms:percentile(times,0.5),p95Ms:percentile(times,0.95),totalMs:times.reduce((a,b)=>a+b,0) })
  }
  const { routeCacheRedis } = await import("../src/server/cache/redis")
  const redis = routeCacheRedis()!
  redis.disconnect()
  const withoutRedis = await fetch(origin+paths[0], { headers: { ...headers, "if-none-match":tag } })
  if (withoutRedis.status!==200 || withoutRedis.headers.get("x-datool-cache")!=="bypass") throw new Error("Redis disconnect blocked normal reads")
  await redis.connect()
  const report={ generatedAt:new Date().toISOString(), environment:{ traces,spans:traces*5,rounds,pollMs:3000,writerIntervalMs:250,transport:"real HTTP and application route handlers via integration adapter; excludes Next runtime, TLS and WAN" }, results, writeComparison,
    checks:{ unauthorizedStatus:denied.status,crossProjectStatus:wrongProject.status,forcedRefresh:force.status,redisUnavailableStatus:withoutRedis.status } }
  await mkdir("artifacts/trace-refresh",{ recursive:true }); await writeFile(output,JSON.stringify(report,null,2))
  console.info(`Report: ${output}`)
} finally {
  stopWriter=true; await writer
  server?.stop()
  const { routeCacheRedis } = await import("../src/server/cache/redis")
  await routeCacheRedis()?.quit()
  await pools?.db.end(); await pools?.analyticsDb.end()
  await seed.end(); await target.close()
}
