import { Redis } from "ioredis"
import { pollingCacheStore } from "./polling-cache-store"
import {
  createStaleWhileRevalidate,
  type SwrStore,
} from "./stale-while-revalidate"

export function redisSwrStore(redis: Redis): SwrStore {
  return {
    get: (key) => redis.get(key),
    lock: async (key, token, ttl) =>
      (await redis.set(`${key}:lock`, token, "PX", ttl, "NX")) === "OK",
    publish: async (key, token, value, ttl) => {
      await redis.eval(
        `if redis.call('get', KEYS[2]) == ARGV[1] then
        return redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
        return 0`,
        2,
        key,
        `${key}:lock`,
        token,
        value,
        ttl
      )
    },
    unlock: async (key, token) => {
      await redis.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1]) end
        return 0`,
        1,
        `${key}:lock`,
        token
      )
    },
  }
}

let connection: Redis | null | undefined
/** Shared best-effort data-cache connection; never used for durable queues. */
export function routeCacheRedis() {
  if (connection === undefined) {
    connection = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: 500,
          commandTimeout: 500,
        })
      : null
    connection?.on("error", () => {})
  }
  return connection
}

let cache: ReturnType<typeof createStaleWhileRevalidate> | undefined
/** Cache connections fail quickly; database reads continue if Redis is unavailable. */
export function routeSwrCache() {
  if (!cache) {
    const redis = routeCacheRedis()
    cache = createStaleWhileRevalidate(redis ? redisSwrStore(redis) : null)
  }
  return cache
}

let polling: ReturnType<typeof createStaleWhileRevalidate> | undefined
/** Shared project/global budgets cover only polling revisions, responses and leases. */
export function pollingSwrCache() {
  if (!polling) {
    const redis = routeCacheRedis()
    polling = createStaleWhileRevalidate(redis ? pollingCacheStore(redis) : null)
  }
  return polling
}
