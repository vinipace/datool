import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { Pool } from "pg"
import { Redis } from "ioredis"
import { createStaleWhileRevalidate, type SwrStore } from "@/src/server/cache/stale-while-revalidate"
import { redisSwrStore } from "@/src/server/cache/redis"
import { createTraceReadCache } from "@/src/server/tracer/trace-read-cache"
import { createConditionalReadCache } from "@/src/lib/tracer/conditional-read"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"

function fixture() {
  let clock = 90_000, revision = "a", loads = 0, revisions = 0
  const values = new Map<string, string>()
  const store: SwrStore = {
    get: async key => values.get(key) ?? null,
    lock: async () => true,
    publish: async (key, _token, value) => { values.set(key, value) },
    unlock: async () => {},
  }
  const read = createTraceReadCache({
    cache: createStaleWhileRevalidate(store, () => clock), now: () => clock,
    revision: async () => { revisions++; return revision },
  })
  const request = { projectId: "p", key: "list", versioned: true,
    load: async () => { loads++; return { name: revision } } }
  return { read, request, advance: (ms: number) => { clock += ms },
    change: (value: string) => { revision = value }, counts: () => ({ loads, revisions }) }
}

test("quiet polling avoids data reads; committed changes and clock windows revalidate", async () => {
  const f = fixture()
  const initial = await f.read(f.request)
  expect(initial.unchanged).toBe(false)
  for (let i = 0; i < 5; i++) {
    f.advance(3000)
    expect((await f.read({ ...f.request, etag: initial.etag })).unchanged).toBe(true)
  }
  expect(f.counts().loads).toBe(1)
  f.change("b"); f.advance(3000)
  const changed = await f.read({ ...f.request, etag: initial.etag })
  expect(changed.unchanged).toBe(false)
  if (!changed.unchanged) expect(changed.data).toEqual({ name: "b" })
  expect(changed.etag).not.toBe(initial.etag)
  f.advance(30_000)
  expect((await f.read({ ...f.request, etag: changed.etag })).unchanged).toBe(false)
})

test("shared cache coalesces readers and never relabels old data with a newer revision", async () => {
  const f = fixture()
  const initial = await f.read(f.request)
  f.change("b"); f.advance(1100)
  const retained = await f.read({ ...f.request, etag: initial.etag })
  expect(retained.unchanged).toBe(false)
  expect(retained.etag).toBe(initial.etag)
  if (!retained.unchanged) expect(retained.data.name).toBe("a")
  f.advance(1000)
  const responses = await Promise.all(Array.from({ length: 20 }, () => f.read({ ...f.request, etag: retained.etag })))
  expect(f.counts().loads).toBe(2)
  for (const response of responses) {
    expect(response.unchanged).toBe(false)
    if (!response.unchanged) expect(response.data.name).toBe("b")
  }
})

test("query/project isolation, explicit refresh, errors and cache absence preserve reads", async () => {
  const f = fixture(), initial = await f.read(f.request)
  for (const request of [{ ...f.request, projectId: "other" }, { ...f.request, key: "other filter" }, { ...f.request, force: true }]) {
    expect((await f.read({ ...request, etag: initial.etag })).unchanged).toBe(false)
  }
  const read = createTraceReadCache({ cache: createStaleWhileRevalidate(null), revision: async () => "a" })
  expect((await read({ ...f.request, etag: initial.etag })).state).toBe("bypass")
  const unavailable = createTraceReadCache({ cache: createStaleWhileRevalidate(null), revision: async () => { throw new Error("unavailable") }, available: () => false })
  expect((await unavailable({ ...f.request, etag: initial.etag })).state).toBe("bypass")
  await rejects(read({ ...f.request, load: async () => { throw new Error("read failed") } }), /read failed/)
})

test("browser validators retain data on 304, isolate keys, bound age, and never hide auth failure", async () => {
  let now = 0
  const cache = createConditionalReadCache(() => now)
  const full = () => Response.json({ data: { name: "first" } }, { headers: { etag: 'W/"a"' } })
  await cache.fetch("p:list", async etag => { expect(etag).toBeUndefined(); return full() })
  const retained = await cache.fetch("p:list", async etag => { expect(etag).toBe('W/"a"'); return new Response(null, { status: 304 }) })
  expect(await retained.json()).toEqual({ data: { name: "first" } })
  await cache.fetch("other:list", async etag => { expect(etag).toBeUndefined(); return full() })
  expect((await cache.fetch("p:list", async () => new Response("Denied", { status: 403 }))).status).toBe(403)
  await cache.fetch("p:list", async etag => { expect(etag).toBeUndefined(); return full() })
  now = 60_001
  await cache.fetch("p:list", async etag => { expect(etag).toBeUndefined(); return full() })
  await cache.fetch("p:list", async etag => { expect(etag).toBeUndefined(); return full() }, true)
  cache.clear()
  await cache.fetch("p:list", async etag => { expect(etag).toBeUndefined(); return full() })
})

test("real PostgreSQL revisions cover existing trace/span changes, rollback and project isolation", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const redisUrl = process.env.DATOOL_TEST_REDIS_URL
  if (!redisUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(redisUrl).hostname)) throw new Error("Disposable loopback Redis required")
  const redis = new Redis(redisUrl)
  try {
    await migrateIsolatedPostgres(target); await seedTestWorkspace(target)
    const revision = async (projectId: string) => (await pool.query("SELECT md5(string_agg(bucket::text || ':' || revision::text, ',' ORDER BY bucket)) AS revision FROM trace_read_revisions WHERE project_id=$1", [projectId])).rows[0]?.revision ?? "empty"
    let clock = 90_000
    const read = createTraceReadCache({ cache: createStaleWhileRevalidate(redisSwrStore(redis), () => clock), now: () => clock, revision })
    const request = { projectId: target.projectId, key: "test", versioned: true, load: async () => (await pool.query("SELECT name FROM traces WHERE project_id=$1 ORDER BY id", [target.projectId])).rows }
    await pool.query("INSERT INTO traces (id,project_id,name,operation,status,started_at) VALUES ('test',$1,'Initial','test','running',now())", [target.projectId])
    const initial = await read(request), v1 = await revision(target.projectId)
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("UPDATE traces SET name='Rolled back' WHERE id='test'")
      expect(await revision(target.projectId)).toBe(v1)
      await client.query("ROLLBACK")
    } finally { client.release() }
    expect(await revision(target.projectId)).toBe(v1)
    await pool.query("UPDATE traces SET name='Completed', status='completed' WHERE id='test'")
    expect(await revision(target.projectId)).not.toBe(v1)
    clock += 3000
    const completed = await read({ ...request, etag: initial.etag })
    expect(completed.unchanged).toBe(false)
    if (!completed.unchanged) expect(completed.data[0].name).toBe("Completed")
    const v2 = await revision(target.projectId)
    await pool.query("INSERT INTO spans (id,project_id,trace_id,name,kind,status,started_at) VALUES ('late',$1,'test','Late','task','running',now())", [target.projectId])
    expect(await revision(target.projectId)).not.toBe(v2)
    const v3 = await revision(target.projectId)
    await pool.query("UPDATE spans SET status='completed' WHERE id='late'")
    expect(await revision(target.projectId)).not.toBe(v3)
    const v4 = await revision(target.projectId)
    await pool.query("DELETE FROM spans WHERE id='late'")
    expect(await revision(target.projectId)).not.toBe(v4)
    const otherId = crypto.randomUUID()
    await pool.query("INSERT INTO project(id,organization_id,name,slug,created_at,updated_at) VALUES ($1,$2,'Other','other',now(),now())", [otherId,target.organizationId])
    await pool.query("INSERT INTO traces (id,project_id,name,operation,status,started_at) SELECT 'bulk-'||n,$1,'Bulk','test','completed',now() FROM generate_series(1,1000)n", [target.projectId])
    const buckets = Number((await pool.query("SELECT count(*) FROM trace_read_revisions WHERE project_id=$1", [target.projectId])).rows[0].count)
    expect(buckets > 1 && buckets <= 64).toBe(true)
    const ownVersion = await revision(target.projectId)
    await pool.query("INSERT INTO traces (id,project_id,name,operation,status,started_at) VALUES ('other',$1,'Other','test','completed',now())", [otherId])
    expect(await revision(target.projectId)).toBe(ownVersion)
    expect(await revision(otherId)).not.toBe("empty")
    await pool.query("DELETE FROM project WHERE id=$1", [target.projectId])
    expect(await revision(target.projectId)).toBe("empty")
  } finally { await redis.quit(); await pool.end(); await target.close() }
}, 30_000)
