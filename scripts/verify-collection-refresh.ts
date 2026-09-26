import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import { chromium } from "playwright"
import { build } from "esbuild"
import { collectionRefreshFixture } from "./read-load/collection-refresh-fixture"
import { serveWebhook } from "../src/server/apps/webhook"

process.env.DATOOL_COLLECTION_READ_CACHE = "shared"
process.env.DATOOL_TRACE_READ_CACHE = "combined"
const f = await collectionRefreshFixture()
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let browserServer: Awaited<ReturnType<typeof serveWebhook>> | undefined
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
try {
  const paths = ["/api/sessions?limit=10&includeTotal=false", "/api/sessions/session-1",
    "/api/evals?limit=10&includeTotal=false", "/api/evals/run-1?limit=50&includeEvidence=false",
    "/api/evals/compare?leftId=run-1&rightId=run-2&includeEvidence=false&offset=0",
    "/api/evals/groups?groupBy=workflow&limit=2&includeTotal=false"]
  const checks: Record<string, unknown> = {}
  for (const path of paths) {
    const initial = await fetch(f.origin + path, { headers: f.headers })
    assert.equal(initial.status, 200, await initial.clone().text())
    const tag = initial.headers.get("etag")!
    assert(tag, path)
    const data = (await initial.json()).data
    const repeated = await fetch(f.origin + path, { headers: { ...f.headers, "if-none-match": tag } })
    assert.equal(repeated.status, 304, path)
    assert.equal(await repeated.text(), "")
    const denied = await fetch(f.origin + path, { headers: { "x-project-id": f.target.projectId, "if-none-match": tag } })
    assert.equal(denied.status, 401, path)
    const wrongProject = await fetch(f.origin + path, { headers: { ...f.headers, "x-project-id": crypto.randomUUID(), "if-none-match": tag } })
    assert.equal(wrongProject.status, 403, path)
    const forced = await fetch(f.origin + path, { headers: { ...f.headers, "if-none-match": tag, "x-datool-refresh": "force" } })
    assert.equal(forced.status, 200, path)
    assert.equal(forced.headers.get("x-datool-cache"), "bypass")
    assert.deepEqual((await forced.json()).data, data)
    checks[path] = { conditional: 304, unauthorized: 401, wrongProject: 403, forced: 200 }
    const next = data.nextCursor ?? data.nextOffset
    if (next !== null && next !== undefined && !path.startsWith("/api/sessions/session-")) {
      const url = new URL(f.origin + path)
      url.searchParams.set(data.nextOffset !== undefined ? "offset" : "cursor", String(next))
      const page = await fetch(url, { headers: { ...f.headers, "if-none-match": tag } })
      assert.equal(page.status, 200, `Page must not reuse a prior page: ${path}`)
      assert.notEqual(page.headers.get("etag"), tag)
      const second = (await page.json()).data
      const ids = (value: typeof data) => (value.items ?? value.rows ?? value.pairs ?? value.traces).map((row: { id: string }) => row.id)
      if (!path.startsWith("/api/sessions/session-")) assert(!ids(second).some((id: string) => ids(data).includes(id)), path)
    }
  }
  const otherProject = crypto.randomUUID()
  await f.seed.query("INSERT INTO project(id,organization_id,name,slug,created_at,updated_at) VALUES($1,$2,'Other','other',now(),now())", [otherProject, f.target.organizationId])
  for (const path of paths) {
    const own = await fetch(f.origin + path, { headers: f.headers })
    const tag = own.headers.get("etag")!
    await own.text()
    const other = await fetch(f.origin + path, { headers: { ...f.headers, "x-project-id": otherProject, "if-none-match": tag } })
    if ([paths[0], paths[2], paths[5]].includes(path)) {
      assert.equal(other.status, 200)
      assert.notEqual(other.headers.get("etag"), tag)
      assert.deepEqual((await other.json()).data.items, [])
    } else {
      assert.equal(other.status, 404)
      await other.text()
    }
  }
  checks.authorizedProjectIsolation = true
  const itemPath = "/api/traces?datasetItemId=frozen-item&limit=50&includeTotal=false"
  const beforeItem = await fetch(f.origin + itemPath, { headers: f.headers })
  const itemTag = beforeItem.headers.get("etag")!
  assert.deepEqual((await beforeItem.json()).data.items, [])
  await f.seed.query(`UPDATE eval_run_targets SET snapshot_json=jsonb_set(snapshot_json::jsonb,
    '{datasetItem}', '{"id":"frozen-item"}')::text WHERE id='target-2-1'`)
  await sleep(2100)
  const afterItem = await fetch(f.origin + itemPath, { headers: { ...f.headers, "if-none-match": itemTag } })
  assert.equal(afterItem.status, 200)
  assert.notEqual(afterItem.headers.get("etag"), itemTag)
  assert.deepEqual((await afterItem.json()).data.items.map((row: { id: string }) => row.id), ["trace-1"])
  checks.datasetMembershipWithoutTraceWrite = true
  const path = paths[3]
  const before = await fetch(f.origin + path, { headers: f.headers })
  const tag = before.headers.get("etag")!
  await before.text()
  await f.seed.query("UPDATE eval_results SET score=0.25 WHERE id='result-1-1'")
  await sleep(2100)
  const changed = await fetch(f.origin + path, { headers: { ...f.headers, "if-none-match": tag } })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get("etag"), tag)
  const scoreData = (await changed.json()).data
  assert.equal(scoreData.rows[0].results[0].score, 0.25)
  await f.seed.query("UPDATE eval_runs SET status='completed', completed_at=now() WHERE id='run-1'")
  await f.seed.query("UPDATE sessions SET name='Renamed session' WHERE id='session-1'")
  await sleep(2100)
  const completed = await fetch(f.origin + path, { headers: f.headers })
  assert.equal((await completed.json()).data.status, "completed")
  const renamed = await fetch(f.origin + paths[1], { headers: f.headers })
  assert.equal((await renamed.json()).data.name, "Renamed session")
  await f.seed.query("DELETE FROM eval_runs WHERE id='run-1'")
  await sleep(2100)
  assert.equal((await fetch(f.origin + path, { headers: { ...f.headers, "if-none-match": changed.headers.get("etag")! } })).status, 404)
  checks.freshness = { independentScoreUpdate: true, completedRun: true, renamedSession: true, deletedRun: true, waitMs: 2100 }

  const warm = await fetch(f.origin + paths[0], { headers: f.headers })
  const sessionTag = warm.headers.get("etag")!
  await warm.text()
  f.redis.disconnect()
  const withoutRedis = await fetch(f.origin + paths[0], { headers: { ...f.headers, "if-none-match": sessionTag } })
  assert.equal(withoutRedis.status, 200)
  assert.equal(withoutRedis.headers.get("x-datool-cache"), "bypass")
  await withoutRedis.text(); await f.redis.connect()
  checks.redisUnavailable = 200

  const built = await build({ entryPoints: ["components/tracer/api.ts"], platform: "browser", format: "esm", bundle: true, write: false })
  browserServer = await serveWebhook(async request => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/api/")) return f.route(request)
    if (path === "/client.js") return new Response(built.outputFiles[0].text, { headers: { "content-type": "text/javascript" } })
    return new Response(`<main data-project-id="${f.target.projectId}" data-organization-id="${f.target.organizationId}" data-project-prefix="/p/test"></main><script type="module">import {tracerApi} from '/client.js'; window.collectionApi=tracerApi;</script>`, { headers: { "content-type": "text/html" } })
  })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ extraHTTPHeaders: f.headers })
  const page = await context.newPage()
  const statuses: { path: string; status: number }[] = []
  page.on("response", response => {
    if (new URL(response.url()).pathname.startsWith("/api/")) statuses.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  await page.goto(`http://127.0.0.1:${browserServer.port}/p/test/evals`)
  await page.waitForFunction(() => "collectionApi" in window)
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { collectionApi: typeof import("../components/tracer/api").tracerApi }).collectionApi
    const before = await api.sessions.list({ includeTotal: false })
    const repeated = await api.sessions.list({ includeTotal: false })
    const evals = await api.evals.list({ includeTotal: false })
    const repeatedEvals = await api.evals.list({ includeTotal: false })
    const created = await api.sessions.create({ name: "Browser mutation proof" })
    const after = await api.sessions.list({ includeTotal: false })
    const forced = await api.evals.list({ includeTotal: true })
    return { same: JSON.stringify(before) === JSON.stringify(repeated), sameEvals: JSON.stringify(evals) === JSON.stringify(repeatedEvals),
      createdVisible: after.items.some(session => session.id === created.id), forcedTotal: forced.total }
  })
  assert(result.same && result.sameEvals && result.createdVisible)
  assert.equal(result.forcedTotal, 49)
  assert(statuses.some(item => item.path === "/api/sessions" && item.status === 304))
  assert(statuses.some(item => item.path === "/api/evals" && item.status === 304))
  await context.setExtraHTTPHeaders({})
  assert(await page.evaluate(async () => {
    try {
      const api = (window as unknown as { collectionApi: typeof import("../components/tracer/api").tracerApi }).collectionApi
      await api.evals.list({ includeTotal: false }); return false
    } catch { return true }
  }))
  checks.browser = { ...result, authRejected: true, statuses }
  await mkdir("artifacts/trace-refresh", { recursive: true })
  await writeFile("artifacts/trace-refresh/collection-verification.json", JSON.stringify(checks, null, 2))
  console.info(JSON.stringify(checks))
} finally { await browser?.close(); browserServer?.stop(); await f.close() }
