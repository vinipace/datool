import { rejects } from "node:assert/strict"
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { Redis } from "ioredis"
import { pollingBudgetKeys, pollingCacheLimits, pollingCacheStore, type PollingCacheLimits } from "@/src/server/cache/polling-cache-store"
import { createStaleWhileRevalidate, swrCacheKey } from "@/src/server/cache/stale-while-revalidate"
import { redisSwrStore } from "@/src/server/cache/redis"
import { localEndpoint } from "../scripts/read-load/safety"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const projectField = (scope: string) => createHash("sha256").update(scope).digest("hex")

async function fixture(limits: PollingCacheLimits = { projectBytes: 32 * 1024, globalBytes: 64 * 1024 }) {
  const url = process.env.DATOOL_TEST_REDIS_URL ?? ""
  localEndpoint(url, ["redis:"])
  const clients = Array.from({ length: 3 }, () => new Redis(url))
  await Promise.all(clients.map(redis => redis.ping()))
  const namespace = `polling-test-${crypto.randomUUID()}`
  const prefix = `datool:swr:${namespace}:budget`
  const budget = pollingBudgetKeys(prefix)
  const stores = clients.map(redis => pollingCacheStore(redis, limits, prefix))
  const keys = new Set<string>(budget)
  const key = (scope: string, query: unknown) => {
    const value = swrCacheKey(namespace, scope, query)
    keys.add(value); keys.add(`${value}:lock`)
    return value
  }
  const read = (scope: string, query: unknown, load: () => Promise<unknown>, index = 0, force = false) => {
    key(scope, query)
    return createStaleWhileRevalidate(stores[index])({ namespace, scope, key: query, freshMs: 1999, maxAgeMs: 2000, defer: () => {}, load, force })
  }
  return { clients, redis: clients[0], stores, key, budget, read,
    usage: async () => Object.fromEntries(Object.entries(await clients[0].hgetall(budget[2])).map(([k,v]) => [k, Number(v)])),
    close: async () => { await clients[0].del(...keys); await Promise.all(clients.map(redis => redis.quit())) },
  }
}

test("polling budgets have bounded defaults and invalid or zero settings disable admission", () => {
  expect(pollingCacheLimits({})).toEqual({ projectBytes: 4 * 1024 * 1024, globalBytes: 64 * 1024 * 1024 })
  for (const value of ["", "-1", "NaN", "1.5", "Infinity", "9007199254740992", "0"])
    expect(pollingCacheLimits({ DATOOL_POLLING_CACHE_PROJECT_BYTES: value }).projectBytes).toBe(0)
  expect(pollingCacheLimits({ DATOOL_POLLING_CACHE_GLOBAL_BYTES: "8192" }).globalBytes).toBe(8192)
})

test("concurrent connections share atomic project/global budgets, including in-flight leases", async () => {
  const f = await fixture({ projectBytes: 4 * 4096, globalBytes: 8 * 4096 })
  try {
    const admitted = await Promise.all(Array.from({ length: 60 }, async (_, i) => {
      const scope = i % 2 ? "a" : "b", key = f.key(scope, i), store = f.stores[i % 3]
      return { scope, key, store, ok: await store.lock(key, `token-${i}`, 2000, scope), token: `token-${i}` }
    }))
    expect(admitted.filter(x => x.ok)).toHaveLength(8)
    expect(await f.usage()).toEqual({ total: 8 * 4096, [projectField("a")]: 4 * 4096, [projectField("b")]: 4 * 4096 })
    expect(await f.stores[2].lock(f.key("c", 0), "c", 2000, "c")).toBe(false)
    const released = admitted.find(x => x.ok)!
    await released.store.unlock(released.key, released.token)
    expect(await f.stores[2].lock(f.key("c", 0), "c", 2000, "c")).toBe(true)
    expect((await f.usage()).total).toBe(8 * 4096)
    // Denied projects/keys do not create accounting fields or lease keys.
    expect(await f.redis.hlen(f.budget[1])).toBe(8)
  } finally { await f.close() }
})

test("full responses survive project/global exhaustion and oversized payloads without touching queues", async () => {
  const f = await fixture({ projectBytes: 16 * 1024, globalBytes: 32 * 1024 })
  const queue = f.key("queue", "sentinel")
  try {
    await f.redis.set(queue, "durable job")
    const payload = { text: "x".repeat(7000) }
    for (const scope of ["a", "b"]) for (let i = 0; i < 4; i++) {
      expect((await f.read(scope, i, async () => payload, i % 3)).data).toEqual(payload)
      const usage = await f.usage()
      expect(usage.total).toBeLessThanOrEqual(32 * 1024)
      expect(usage[projectField(scope)]).toBeLessThanOrEqual(16 * 1024)
    }
    expect(await f.redis.get(f.key("a", 0))).not.toBeNull()
    expect(await f.redis.get(f.key("a", 3))).toBeNull()
    expect(await f.redis.get(f.key("b", 0))).not.toBeNull()
    const huge = { text: "🧪".repeat(140000) }
    expect((await f.read("other", "huge", async () => huge)).data).toEqual(huge)
    expect(await f.redis.get(f.key("other", "huge"))).toBeNull()
    expect(await f.redis.get(queue)).toBe("durable job")
    // Existing generic dashboard policy is independent of polling limits.
    const generic = redisSwrStore(f.redis), other = f.key("dashboard", 0)
    expect(await generic.lock(other, "dashboard", 1000)).toBe(true)
    await generic.publish(other, "dashboard", "cached dashboard", 1000)
    expect(await f.redis.get(other)).toBe("cached dashboard")
  } finally { await f.close() }
})

test("expiry and crashed leases reclaim capacity; idle accounting also expires", async () => {
  const f = await fixture({ projectBytes: 8192, globalBytes: 8192 })
  try {
    const key = f.key("p", "crashed")
    expect(await f.stores[0].lock(key, "dead", 50, "p")).toBe(true)
    expect(await f.stores[1].lock(f.key("p", "other"), "busy", 50, "p")).toBe(true)
    expect(await f.stores[2].lock(f.key("p", "denied"), "no", 50, "p")).toBe(false)
    await sleep(80)
    const next = f.key("p", "next")
    expect(await f.stores[2].lock(next, "next", 1000, "p")).toBe(true)
    await f.stores[2].publish(next, "next", "response", 50, "p")
    await f.stores[2].unlock(next, "next")
    expect((await f.usage()).total).toBe(4096)
    await sleep(80)
    expect(await f.redis.get(next)).toBeNull()
    // No background sweeper is needed when all traffic stops.
    await sleep(1050)
    expect(await f.redis.exists(...f.budget)).toBe(0)
    expect((await f.read("p", "recovered", async () => "fresh")).data).toBe("fresh")
  } finally { await f.close() }
})

test("replacement charges only the current response and rejects superseded lease owners", async () => {
  const f = await fixture()
  try {
    const key = f.key("p", "replace"), [old, fresh] = f.stores
    expect(await old.lock(key, "old", 1000, "p")).toBe(true)
    await old.publish(key, "old", "x".repeat(10000), 2000, "p")
    await old.unlock(key, "old")
    const initial = (await f.usage()).total
    expect(await old.lock(key, "expired", 25, "p")).toBe(true)
    await sleep(50)
    expect(await fresh.lock(key, "new", 1000, "p")).toBe(true)
    await old.publish(key, "expired", "incorrect", 2000, "p")
    await old.unlock(key, "expired")
    expect(await f.redis.get(`${key}:lock`)).toBe("new")
    await fresh.publish(key, "new", "small", 2000, "p")
    await fresh.unlock(key, "new")
    expect(await f.redis.get(key)).toBe("small")
    expect((await f.usage()).total).toBe(4096)
    expect((await f.usage()).total).toBeLessThan(initial)
    expect(await f.redis.hlen(f.budget[1])).toBe(1)
  } finally { await f.close() }
})

test("disabled admission and database errors leave no cache metadata behind", async () => {
  const f = await fixture({ projectBytes: 0, globalBytes: 0 })
  try {
    expect((await f.read("p", 0, async () => "complete")).data).toBe("complete")
    await rejects(f.read("p", 1, async () => { throw new Error("database unavailable") }), /database unavailable/)
    expect(await f.redis.exists(...f.budget)).toBe(0)
  } finally { await f.close() }
})


test("loader failure releases its reserved lease and leaves capacity for another reader", async () => {
  const f = await fixture({ projectBytes: 8192, globalBytes: 8192 })
  try {
    await rejects(f.read("p", "error", async () => { throw new Error("failed") }), /failed/)
    expect(await f.redis.exists(...f.budget)).toBe(0)
    await f.read("p", "good", async () => "complete")
    expect((await f.usage()).total).toBe(4096)
    expect(await f.redis.get(f.key("p", "good"))).not.toBeNull()
  } finally { await f.close() }
})
