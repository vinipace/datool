/** Three app processes, real HTTP/database reads, disposable Redis restart and memory accounting. */
import { createHash } from "node:crypto"
import { pollingCacheStore, pollingBudgetKeys } from "../src/server/cache/polling-cache-store"
import { strict as assert } from "node:assert"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { collectionRefreshFixture } from "./read-load/collection-refresh-fixture"
import { createConditionalReadCache } from "../src/lib/tracer/conditional-read"
import { swrCacheKey } from "../src/server/cache/stale-while-revalidate"
const exec = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const container = process.env.DATOOL_TEST_REDIS_CONTAINER
if (container !== "datool-cache-resilience-redis") throw new Error("Explicit disposable Redis container name required")
const details = JSON.parse((await exec("docker", ["inspect", container])).stdout)[0]
assert(details.Config.Image.startsWith("redis:"))
const binding = details.NetworkSettings.Ports["6379/tcp"][0]
assert.equal(binding.HostIp, "127.0.0.1")
assert.equal(binding.HostPort, new URL(process.env.DATOOL_TEST_REDIS_URL!).port)
const f = await collectionRefreshFixture()
let id = 0, stoppingWriter = false, writer: Promise<void> | undefined
const children: Awaited<ReturnType<typeof app>>[] = []
async function app(settings: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--no-env-file", "scripts/read-load/refresh-process.ts"], {
    env: { ...process.env, DATABASE_URL: f.target.databaseUrl, REDIS_URL: process.env.DATOOL_TEST_REDIS_URL,
      DATOOL_TRACE_READ_CACHE: "combined", DATOOL_COLLECTION_READ_CACHE: "shared", ...settings },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let stderr = ""
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-4000) })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const entered = new Map<number, () => void>()
  const ready = Promise.withResolvers<{ port: number; pid: number }>()
  child.on("message", (message: { ready?: boolean; port: number; pid: number; entered?: number; id: number; result: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message)
    else if (message.entered) entered.get(message.entered)?.()
    else {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result)
    }
  })
  child.on("exit", () => {
    const error = new Error(`Child exited: ${stderr}`)
    ready.reject(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  const timeout = setTimeout(() => ready.reject(new Error(`Child startup timeout: ${stderr}`)), 20_000)
  let started: { port: number; pid: number }
  try { started = await ready.promise } catch (error) { child.kill(); throw error } finally { clearTimeout(timeout) }
  const send = <T = unknown>(action: string, options: Record<string, unknown> = {}, onEntered?: () => void) => {
    const requestId = ++id
    if (onEntered) entered.set(requestId, onEntered)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Child command timeout: ${action}`)) }, 15_000)
      pending.set(requestId, {
        resolve: value => { clearTimeout(timer); entered.delete(requestId); resolve(value as T) },
        reject: error => { clearTimeout(timer); entered.delete(requestId); reject(error) },
      })
      child.send({ id: requestId, action, ...options })
    })
  }
  return { child, ...started, origin: `http://127.0.0.1:${started.port}`, send }
}
const cachePattern = "datool:swr:*"
async function keys() {
  let cursor = "0"
  const found: string[] = []
  do { const page = await f.redis.scan(cursor, "MATCH", cachePattern, "COUNT", 1000); cursor = page[0]; found.push(...page[1]) } while (cursor !== "0")
  return found
}
function info(text: string) { return Object.fromEntries(text.split("\r\n").filter(line => line.includes(":" )).map(line => { const i = line.indexOf(":"); return [line.slice(0,i), line.slice(i+1)] })) }
async function memory() {
  const all = await keys()
  const pipe = f.redis.pipeline()
  for (const key of all) { pipe.memory("USAGE", key); pipe.pttl(key) }
  const values = await pipe.exec() ?? []
  const namespaces: Record<string, { keys: number; bytes: number; minTtlMs: number; maxTtlMs: number }> = {}
  all.forEach((key, index) => {
    const bytes = Number(values[index*2]?.[1] ?? 0), ttl = Number(values[index*2+1]?.[1] ?? -2)
    if (ttl < 0 || !bytes) return
    const name = key.split(":")[2] + (key.endsWith(":lock") ? ":lock" : "")
    const group = namespaces[name] ??= { keys: 0, bytes: 0, minTtlMs: Infinity, maxTtlMs: 0 }
    group.keys++; group.bytes += bytes; group.minTtlMs = Math.min(group.minTtlMs, ttl); group.maxTtlMs = Math.max(group.maxTtlMs, ttl)
  })
  const system = info(await f.redis.info("memory"))
  return { namespaces, keys: Object.values(namespaces).reduce((sum,v) => sum+v.keys,0), bytes: Object.values(namespaces).reduce((sum,v) => sum+v.bytes,0),
    usedMemory: Number(system.used_memory), rss: Number(system.used_memory_rss) }
}
async function commands() {
  const stats = info(await f.redis.info("commandstats"))
  return Object.fromEntries(["get","set","eval","evalsha","del","incr","expire","pexpire","pexpireat","exists","time","hget","hset","hdel","hincrby","zadd","zrem","zrangebyscore","zrevrange","zscore"].map(name => [name, Number(stats[`cmdstat_${name}`]?.match(/calls=(\d+)/)?.[1] ?? 0)]))
}
async function fetchData<T>(node: number, path: string, headers: Record<string,string> = {}) {
  const response = await fetch(children[node].origin + path, { headers: { ...f.headers, ...headers }, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).data as T
}
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), environment: "3 independent Bun app processes; actual authenticated route handlers via local Node HTTP adapter; PostgreSQL 17 and Redis 7; amd64 Docker images on ARM; synthetic data; no Next runtime or WAN" }
try {
  for (let i = 0; i < 3; i++) children.push(await app())
  assert.equal(new Set(children.map(child => child.pid)).size, 3)
  const paths = ["/api/traces?limit=50&includeTotal=false", "/api/traces/trace-1/overview", "/api/sessions/session-1",
    "/api/evals/run-1?includeEvidence=false&limit=50", "/api/evals/compare?leftId=run-1&rightId=run-2&includeEvidence=false&offset=0"]
  for (const path of paths) {
    const response = await fetch(children[0].origin + path, { headers: f.headers })
    assert.equal(response.status, 200)
    const tag = response.headers.get("etag")!
    assert(tag)
    await response.text()
    for (const node of [1,2]) {
      const other = await fetch(children[node].origin + path, { headers: { ...f.headers, "if-none-match": tag } })
      assert.equal(other.status, 304, path); assert.equal(await other.text(), "")
    }
  }
  report.sharedValidatorsAcrossProcesses = true
  // Writer commits four times a second while conditional clients rotate app processes.
  let writes = 0, reads = 0, unchanged = 0
  const seen = new Set<string>(["Trace 1"])
  const caches = Array.from({ length: 6 }, () => createConditionalReadCache())
  stoppingWriter = false
  writer = (async () => {
    while (!stoppingWriter) {
      const name = `Concurrent ${++writes}`
      await f.seed.query("UPDATE traces SET name=$1 WHERE id='trace-1'", [name]); seen.add(name)
      await f.seed.query("UPDATE eval_results SET score=$1 WHERE id='result-1-1'", [(writes%90)/100])
      await sleep(250)
    }
  })()
  const started = performance.now()
  const outageStart = performance.now()
  const restart = (async () => {
    await sleep(1200)
    await exec("docker", ["stop", "-t", "1", container!])
    await sleep(1800)
    await exec("docker", ["start", container!])
  })()
  let bypass = 0
  for (let round = 0; round < 24; round++) {
    await Promise.all(caches.map(async (cache, index) => {
      const path = index % 2 ? paths[3] : paths[1]
      const response = await cache.fetch(path, async etag => {
        const response = await fetch(children[(round+index)%3].origin + path, { headers: { ...f.headers, ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(15000) })
        assert(response.ok || response.status === 304, `${response.status}: ${await response.clone().text()}`)
        if (response.status === 304) unchanged++
        if (response.headers.get("x-datool-cache") === "bypass") bypass++
        reads++
        return response
      })
      const data = (await response.json()).data
      if (index % 2) assert(data.rows.length === 50 && Number.isFinite(data.rows[0].results[0].score))
      else assert(seen.has(data.name), data.name)
    }))
    await sleep(150)
  }
  await restart
  stoppingWriter = true; await writer; writer = undefined
  assert(bypass > 0, "Redis outage must exercise DB fallback")
  for (let retry = 0; retry < 30; retry++) {
    if ((await Promise.all(children.map(child => child.send<{redis:string}>("status")))).every(status => status.redis === "ready")) break
    await sleep(100)
  }
  assert((await Promise.all(children.map(child => child.send<{redis:string}>("status")))).every(status => status.redis === "ready"))
  await sleep(2200)
  for (const node of [0,1,2]) {
    assert.equal((await fetchData<{name:string}>(node, paths[1])).name, `Concurrent ${writes}`)
    const run = await fetchData<{rows:{results:{score:number}[]}[]}>(node, paths[3])
    assert.equal(run.rows[0].results[0].score, (writes%90)/100)
  }
  const targetIds = new Set<string>()
  let cursor: string | null = null
  for (const node of [0,1,2]) {
    const page: { rows: {id:string}[]; nextCursor: string | null } = await fetchData(node,
      `/api/evals/run-1?includeEvidence=false&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    assert.equal(page.rows.length, 50)
    for (const row of page.rows) { assert(!targetIds.has(row.id)); targetIds.add(row.id) }
    cursor = page.nextCursor
  }
  assert.equal(targetIds.size, 150)
  report.paginationAcrossProcesses = { pages: 3, uniqueRows: targetIds.size }
  report.concurrentRestart = { reads, writes, unchanged, bypass, httpFailures: 0, elapsedMs: performance.now()-started, restartScenarioMs: performance.now()-outageStart, convergedAfterQuiescenceMs: 2200 }
  console.info(JSON.stringify({ concurrentRestart: report.concurrentRestart }))
  // Delayed old loader must not overwrite a value from a newer process after expiry.
  const slowKey = `resilience-slow-${crypto.randomUUID()}`
  const entered = Promise.withResolvers<void>()
  const oldName = `Concurrent ${writes}`
  const slow = children[0].send<{data:{name:string}}>("slow", { key: slowKey, delayMs: 2600, projectId: f.target.projectId }, entered.resolve)
  await entered.promise
  await f.seed.query("UPDATE traces SET name='After slow read' WHERE id='trace-1'")
  const newer = await children[1].send<{data:{name:string}}>("slow", { key: slowKey, projectId: f.target.projectId })
  assert.equal(newer.data.name, "After slow read")
  assert.equal((await slow).data.name, oldName)
  const final = await children[2].send<{data:{name:string}}>("slow", { key: slowKey, projectId: f.target.projectId })
  assert.equal(final.data.name, "After slow read")
  report.slowOldLoaderCannotPublishAfterExpiry = true
  // Crash a lease owner. Another process still reads correctly without waiting for its lease.
  const crashKey = `resilience-crash-${crypto.randomUUID()}`
  const crashEntered = Promise.withResolvers<void>()
  const crashed = children[2].send("slow", { key: crashKey, delayMs: 10000, projectId: f.target.projectId }, crashEntered.resolve).catch(() => null)
  await crashEntered.promise
  children[2].child.kill("SIGKILL"); await crashed
  await f.seed.query("UPDATE traces SET name='After app crash' WHERE id='trace-1'")
  const recovered = await children[1].send<{data:{name:string}}>("slow", { key: crashKey, projectId: f.target.projectId })
  assert.equal(recovered.data.name, "After app crash")
  const lease = `${swrCacheKey("collection-read-response-v2", f.target.projectId, crashKey)}:lock`
  const leaseTtlMs = await f.redis.pttl(lease)
  assert(leaseTtlMs > 0 && leaseTtlMs <= 120000)
  report.appCrash = { freshReadWhileLeaseHeld: true, orphanLeaseTtlMs: leaseTtlMs, orphanLeaseBytes: Number(await f.redis.memory("USAGE", lease)) }
  await pollingCacheStore(f.redis).unlock(lease.slice(0, -5), (await f.redis.get(lease))!)
  children[2] = await app()
  // Durable rollback cannot announce a new version, even across processes.
  const revision = async () => (await f.seed.query("SELECT md5(string_agg(bucket::text||':'||revision::text,',' ORDER BY bucket)) AS value FROM trace_read_revisions WHERE project_id=$1", [f.target.projectId])).rows[0].value
  const before = await revision(), tx = await f.seed.connect()
  try { await tx.query("BEGIN"); await tx.query("UPDATE traces SET name='Never committed' WHERE id='trace-1'"); assert.equal(await revision(), before); await tx.query("ROLLBACK") } finally { tx.release() }
  for (const node of [0,1,2]) assert.equal((await fetchData<{name:string}>(node, paths[1], { "x-datool-refresh":"force" })).name, "After app crash")
  report.rollbackAcrossProcesses = true

  // Real route key sizes and command volume. Read-only telemetry is excluded from command categories.
  const workloads = [
    { name: "same-pages", clients: 12, distinct: false },
    { name: "distinct-filters", clients: 24, distinct: true },
  ]
  const measurements = []
  for (const workload of workloads) {
    for (const mode of ["off", "combined"]) {
      await Promise.all(children.map(child => child.send("mode", { mode })))
      await sleep(3200)
      const baseline = await memory(), beforeCommands = await commands()
      let peak = baseline, requestBytes = 0, requestCount = 0, sampling = true
      const samples = (async () => {
        while (sampling) { const sample = await memory(); if (sample.bytes > peak.bytes) peak = sample; await sleep(100) }
      })()
      const begun = performance.now()
      try {
        const clients = Array.from({ length: workload.clients }, () => createConditionalReadCache())
        for (let round = 0; round < 3; round++) {
          await sleep(Math.max(0, begun + round*3000 - performance.now()))
          await Promise.all(clients.map(async (cache, index) => {
            await sleep(index*1500/workload.clients)
            const query = workload.distinct ? `&filter=${encodeURIComponent(`name : "Run" id != "unused-${index}"`)}` : ""
            for (const path of ["/api/evals?limit=50&includeTotal=false" + query, "/api/evals/compare?leftId=run-1&rightId=run-2&includeEvidence=false&offset=0"]) {
              await cache.fetch(path, async etag => {
                const response = await fetch(children[index%3].origin+path, { headers: { ...f.headers, ...(etag ? {"if-none-match":etag} : {}) } })
                assert(response.ok || response.status===304, `${response.status}: ${await response.clone().text()}`)
                requestCount++; requestBytes += (await response.clone().arrayBuffer()).byteLength
                return response
              })
            }
          }))
        }
      } finally { sampling = false; await samples }
      const afterCommands = await commands()
      const elapsedMs = performance.now()-begun
      await sleep(3200)
      const idle = await memory()
      const commandDelta = Object.fromEntries(Object.entries(beforeCommands).map(([name,value]) => [name,afterCommands[name]-value]))
      measurements.push({ ...workload, mode, requests: requestCount, bodyBytes: requestBytes, elapsedMs, peak, baseline, afterIdle: idle,
        commands: commandDelta, selectedCommandsPerSecond: Object.values(commandDelta).reduce((sum,value)=>sum+value,0)/(elapsedMs/1000) })
      console.info(JSON.stringify(measurements.at(-1)))
    }
  }
  report.redisMeasurements = measurements
  // Large distinct responses expose the memory risk of storing full pages.
  await f.seed.query("UPDATE traces SET output_json=to_json(repeat('x', 20000))::text WHERE id IN (SELECT 'trace-'||i FROM generate_series(1,50)i)")
  await sleep(3200)
  const largeBase = await memory()
  const large = []
  for (let i=0; i<8; i++) {
    const page = await fetchData<{items:{output:string}[]}>(0, `/api/traces?limit=50&includeTotal=false&filter=${encodeURIComponent(`name != "unused-${i}"`)}`)
    assert.equal(page.items.length, 50)
    assert.equal(page.items[0].output.length, 20000)
    large.push(await memory())
  }
  assert(large.every(sample => !sample.namespaces["trace-read-response-v2"]), "Oversized trace pages must not be stored")
  report.largeDistinctTracePages = { baseline: largeBase, peak: large.reduce((a,b)=>a.bytes>b.bytes?a:b), samples:large }
  await sleep(3200)
  report.idleAfterLargePages = await memory()
  // Saturate small shared budgets across three independent processes. Real HTTP
  // routes must still return complete data when their responses cannot be stored.
  for (const child of children) await child.send("close")
  const projectBytes = 32 * 1024, globalBytes = 64 * 1024
  for (let i=0; i<3; i++) children[i] = await app({
    DATOOL_POLLING_CACHE_PROJECT_BYTES: String(projectBytes),
    DATOOL_POLLING_CACHE_GLOBAL_BYTES: String(globalBytes),
  })
  const projects = ["budget-a", "budget-b", "budget-c"]
  const usageKey = pollingBudgetKeys()[2]
  let maximum = 0, budgetReads = 0
  for (let round=0; round<16; round++) {
    await Promise.all(children.map(async (child, i) => {
      const result = await child.send<{ data: {text:string} }>("budget", {
        projectId: projects[i], key: `budget-${round}-${i}`,
      })
      assert.equal(result.data.text.length, 2048); budgetReads++
    }))
    const usage = await f.redis.hgetall(usageKey)
    maximum = Math.max(maximum, Number(usage.total ?? 0))
    assert(Number(usage.total ?? 0) <= globalBytes)
    for (const project of projects) assert(Number(usage[createHash("sha256").update(project).digest("hex")] ?? 0) <= projectBytes)
  }
  const stored = await f.redis.hlen(pollingBudgetKeys()[1])
  assert(maximum > 0 && stored > 0 && stored < budgetReads)
  const saturatedRun = await fetchData<{rows:unknown[]}>(0, paths[3])
  assert.equal(saturatedRun.rows.length, 50)
  const runKey = swrCacheKey("collection-read-response-v2", f.target.projectId, paths[3])
  assert.equal(await f.redis.get(runKey), null)
  await sleep(3200)
  assert.equal(await f.redis.exists(...pollingBudgetKeys()), 0)
  const recoveredBudget = await children[2].send<{data:{text:string}}>("budget", {projectId:projects[0],key:"after-expiry"})
  assert.equal(recoveredBudget.data.text.length, 2048)
  assert.equal(Number(await f.redis.hget(usageKey, "total")), 4096)
  report.budgetAcrossProcesses = { projectBytes, globalBytes, maximumAccountedBytes:maximum,
    reads:budgetReads, stored, fullHttpResponseWhileSaturated:true, recoveredAfterExpiry:true }
  console.info(JSON.stringify({ budgetAcrossProcesses: report.budgetAcrossProcesses }))
  await mkdir("artifacts/trace-refresh", { recursive: true })
  const path = `artifacts/trace-refresh/resilience-${new Date().toISOString().replaceAll(":","-")}.json`
  await writeFile(path, JSON.stringify(report,null,2)); console.info(`Report: ${path}`)
} finally {
  stoppingWriter = true; await writer
  for (const child of children) {
    if (child.child.exitCode === null && !child.child.killed) { try { await child.send("close") } catch { child.child.kill("SIGTERM") } }
  }
  // Ensure cleanup can finish even after a failed restart check.
  await exec("docker", ["start", container]).catch(() => {})
  await f.close()
}
