import { expect, test } from "bun:test"
import { Redis } from "ioredis"
import { redisSwrStore } from "@/src/server/cache/redis"
import {
  createStaleWhileRevalidate,
  swrCacheKey,
} from "@/src/server/cache/stale-while-revalidate"

test("Redis persists across cache instances, enforces expiry and rejects superseded leases", async () => {
  const url = process.env.DATOOL_TEST_REDIS_URL
  if (!url)
    throw new Error("DATOOL_TEST_REDIS_URL must point to disposable Redis")
  const redis = new Redis(url)
  const store = redisSwrStore(redis)
  let now = Date.now(),
    loads = 0
  const options = {
    namespace: "test",
    scope: crypto.randomUUID(),
    key: "query",
    freshMs: 100,
    maxAgeMs: 10000,
    load: async () => ++loads,
    defer: (work: () => Promise<void>) => {
      deferred.push(work)
    },
  }
  const deferred: (() => Promise<void>)[] = []
  const key = swrCacheKey(options.namespace, options.scope, options.key)
  try {
    await redis.ping()
    const first = createStaleWhileRevalidate(store, () => now)
    const second = createStaleWhileRevalidate(store, () => now)
    expect((await first(options)).state).toBe("miss")
    expect((await second(options)).state).toBe("fresh")
    expect(loads).toBe(1)
    expect(await redis.pttl(key)).toBeGreaterThan(0)
    expect(await redis.pttl(key)).toBeLessThanOrEqual(10000)
    now += 100
    expect((await second(options)).state).toBe("stale")
    await deferred.shift()!()
    expect((await first(options)).data).toBe(2)
    now += 10000
    expect((await second(options)).state).toBe("miss")
    expect(loads).toBe(3)
    expect(await store.lock(key, "old", 10000)).toBe(true)
    await redis.del(`${key}:lock`)
    expect(await store.lock(key, "new", 10000)).toBe(true)
    await store.publish(key, "old", "wrong", 10000)
    await store.unlock(key, "old")
    expect(await redis.get(`${key}:lock`)).toBe("new")
    expect(JSON.parse((await redis.get(key))!).data).toBe(3)
  } finally {
    await redis.del(key, `${key}:lock`)
    await redis.quit()
  }
})
