/** Real local routes and databases. Measures existing page request patterns, not mocked service costs. */
import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import { collectionRefreshFixture } from "./read-load/collection-refresh-fixture"
import { boundedInteger } from "./read-load/safety"
import { createConditionalReadCache } from "../src/lib/tracer/conditional-read"
import type { ApiList, EvalRunComparison, EvalRunDetail, TraceOverview, TraceSummary } from "../src/lib/tracer/contracts"

const rounds = boundedInteger(process.env.COMPARE_ROUNDS, 6, 2, 30)
const viewers = boundedInteger(process.env.COMPARE_VIEWERS, 4, 2, 50)
const onlyPage = process.env.COMPARE_PAGE
const onlyScenario = process.env.COMPARE_SCENARIO
const f = await collectionRefreshFixture()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const percentile = (values: number[], fraction: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * fraction)-1)] ?? 0
let stopWriter = false, writer: Promise<void> | undefined
function measurement() {
  return { requests: 0, bytes: 0, unchanged: 0, errors: 0, failedRefreshes: 0, requestMs: [] as number[], refreshMs: [] as number[], states: {} as Record<string, number> }
}
function client(nonce: string, stats: ReturnType<typeof measurement>) {
  // Same bounded validator store as the browser: 32 entries, 8 MiB, 60 seconds.
  const cache = createConditionalReadCache()
  return { async read<T>(path: string): Promise<T> {
    const url = f.origin + path + (path.includes("?") ? "&" : "?") + `comparison=${nonce}`
    const response = await cache.fetch(url, async etag => {
      const start = performance.now()
      const response = await fetch(url, { headers: { ...f.headers, ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(30_000) })
      stats.bytes += (await response.clone().arrayBuffer()).byteLength
      stats.requests++; stats.requestMs.push(performance.now() - start)
      if (response.status === 304) stats.unchanged++
      const state = response.headers.get("x-datool-cache") ?? "none"
      stats.states[state] = (stats.states[state] ?? 0) + 1
      if (!response.ok && response.status !== 304) {
        stats.errors++
        throw new Error(`${path}: ${response.status} ${await response.text()}`)
      }
      return response
    })
    return (await response.json()).data as T
  } }
}
// Settle sibling requests before recording a failed refresh or closing the fixture.
async function together<T extends readonly unknown[] | []>(values: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(values)
  for (const result of results) if (result.status === "rejected") throw result.reason
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T
}
type Client = ReturnType<typeof client>
async function sessionPage(c: Client) {
  const [, first] = await together([
    c.read("/api/sessions/session-1"), c.read<ApiList<TraceSummary>>("/api/traces?sessionId=session-1&limit=200"),
  ])
  const summaries = [...first.items]
  let cursor = first.nextCursor
  while (cursor) {
    const page = await c.read<ApiList<TraceSummary>>(`/api/traces?sessionId=session-1&limit=200&cursor=${encodeURIComponent(cursor)}`)
    summaries.push(...page.items); cursor = page.nextCursor
  }
  assert.equal(summaries.length, 20)
  const traces: TraceOverview[] = []
  for (let offset = 0; offset < summaries.length; offset += 4) {
    traces.push(...await together(summaries.slice(offset, offset + 4).map(async trace => {
      const [overview, firstScores] = await together([
        c.read<TraceOverview>(`/api/traces/${trace.id}/overview`),
        c.read<ApiList<unknown>>(`/api/traces/${trace.id}/scores?limit=200`),
      ])
      let next = firstScores.nextCursor
      while (next) {
        next = (await c.read<ApiList<unknown>>(`/api/traces/${trace.id}/scores?limit=200&cursor=${encodeURIComponent(next)}`)).nextCursor
      }
      return overview
    })))
  }
  return traces
}
async function evalPage(c: Client) {
  // Three pages already loaded in the run table and the adjacent comparison.
  await together([
    (async () => {
      let cursor: string | null = null
      for (let page = 0; page < 3; page++) {
        const data: EvalRunDetail = await c.read(`/api/evals/run-1?includeEvidence=false&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : "&includeTotal=false"}`)
        assert.equal(data.rows?.length, 50)
        cursor = data.nextCursor ?? null
      }
    })(),
    (async () => {
      let offset = 0
      for (let page = 0; page < 3; page++) {
        const data = await c.read<EvalRunComparison>(`/api/evals/compare?leftId=run-1&rightId=run-2&includeEvidence=false&offset=${offset}`)
        assert.equal(data.pairs.length, 50)
        offset = data.nextOffset!
      }
    })(),
  ])
}
const pages = [
  { name: "session-detail", pollMs: 5000, load: sessionPage },
  { name: "evaluation-comparison", pollMs: 3000, load: evalPage },
].filter(page => !onlyPage || page.name === onlyPage)
assert(pages.length, "Unknown COMPARE_PAGE")
const results = []
try {
  for (const page of pages) {
    process.env.DATOOL_TRACE_READ_CACHE = "off"; process.env.DATOOL_COLLECTION_READ_CACHE = "off"
    for (let i = 0; i < 2; i++) await page.load(client(`warm-${i}`, measurement()))
    const scenarios = [{ name: "quiet-many", active: false, viewers }, { name: "active-one", active: true, viewers: 1 }, { name: "active-many", active: true, viewers }].filter(scenario => !onlyScenario || scenario.name === onlyScenario)
    assert(scenarios.length, "Unknown COMPARE_SCENARIO")
    for (const scenario of scenarios) {
      let modes = page.name === "session-detail" ? ["off", "trace-only", "extended"] : ["off", "extended"]
      if (scenario.viewers === 1) modes = modes.reverse()
      for (const mode of modes) {
        process.env.DATOOL_TRACE_READ_CACHE = mode === "off" ? "off" : "combined"
        process.env.DATOOL_COLLECTION_READ_CACHE = mode === "extended" ? "shared" : "off"
        const stats = measurement(), nonce = crypto.randomUUID()
        const clients = Array.from({ length: scenario.viewers }, () => client(nonce, stats))
        let writes = 0
        stopWriter = false
        writer = scenario.active ? (async () => {
          while (!stopWriter) {
            const start = performance.now()
            writes++
            if (page.name === "session-detail") {
              await f.seed.query("UPDATE traces SET name=$1 WHERE id='trace-1'", [`Updated ${writes}`])
            } else {
              await f.seed.query("UPDATE eval_results SET score=$1 WHERE id='result-1-1'", [(writes % 99) / 100])
            }
            await sleep(Math.max(0, 250 - (performance.now() - start)))
          }
        })() : undefined
        const start = performance.now()
        f.startCount()
        try {
          for (let round = 0; round < rounds; round++) {
            await sleep(Math.max(0, start + round * page.pollMs - performance.now()))
            await Promise.all(clients.map(async (c, index) => {
              await sleep(index * 1000 / scenario.viewers)
              const started = performance.now()
              try { await page.load(c) } catch (error) {
                stats.failedRefreshes++
                if (stats.failedRefreshes === 1) console.warn(String(error))
              }
              stats.refreshMs.push(performance.now() - started)
            }))
          }
        } finally { stopWriter = true; await writer; writer = undefined }
        const counters = f.stopCount()
        const row = { page: page.name, scenario: scenario.name, mode, viewers: scenario.viewers, rounds, pollMs: page.pollMs,
          requests: stats.requests, bytes: stats.bytes, unchanged: stats.unchanged, errors: stats.errors, failedRefreshes: stats.failedRefreshes, ...counters,
          requestP50Ms: percentile(stats.requestMs, .5), requestP95Ms: percentile(stats.requestMs, .95),
          refreshP50Ms: percentile(stats.refreshMs, .5), refreshP95Ms: percentile(stats.refreshMs, .95),
          writes, elapsedMs: performance.now() - start, states: stats.states }
        results.push(row)
        console.info(JSON.stringify(row))
      }
    }
  }
  const report = { generatedAt: new Date().toISOString(), environment: { sessions: 100, traces: 2000, spans: 10000, evalRuns: 50, targets: 10000, results: 5000,
    sessionTraces: 20, loadedEvalPages: 3, viewers, rounds, note: "Fixed poll cadence. Failed refreshes are recorded; hook error backoff is not simulated. Compare performance only for error-free rows.", viewerSpreadMs: 1000, writerIntervalMs: 250,
    transport: "Actual authenticated application routes via Node HTTP adapter; excludes Next runtime, TLS and WAN. Docker amd64 images on local ARM host.",
    bytes: "Uncompressed response bodies; request counts include all child reads; client uses the real bounded validator store." }, results }
  await mkdir("artifacts/trace-refresh", { recursive: true })
  const output = `artifacts/trace-refresh/collections-${new Date().toISOString().replaceAll(":", "-")}.json`
  await writeFile(output, JSON.stringify(report, null, 2))
  console.info(`Report: ${output}`)
} finally { stopWriter = true; await writer; await f.close() }
