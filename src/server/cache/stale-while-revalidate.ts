import { createHash, randomUUID } from "node:crypto"

export interface SwrStore {
  get(key: string): Promise<string | null>
  lock(key: string, token: string, ttlMs: number, scope?: string): Promise<boolean>
  publish(
    key: string,
    token: string,
    value: string,
    ttlMs: number,
    scope?: string
  ): Promise<void>
  unlock(key: string, token: string): Promise<void>
}
export type CacheState = "fresh" | "stale" | "miss" | "bypass"
export type SwrOptions<T> = {
  namespace: string
  /** Authorization must happen before invoking the cache. Include tenant scope. */
  scope: string
  key: unknown
  freshMs: number
  /** Total age, including the fresh window. Older data is never returned. */
  maxAgeMs: number
  load: () => Promise<T>
  defer: (work: () => Promise<void>) => void
  force?: boolean
  lockMs?: number
  /** Skip publishing larger entries; the caller still receives the complete result. */
  maxEntryBytes?: number
}
export function stableCacheJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  )
}
export function swrCacheKey(namespace: string, scope: string, key: unknown) {
  return `datool:swr:${namespace}:${createHash("sha256").update(stableCacheJson({ scope, key })).digest("hex")}`
}

/** Transport-neutral JSON cache: supply Next after(), a job runner, or another defer. */
export function createStaleWhileRevalidate(
  store: SwrStore | null,
  now = Date.now
) {
  const flights = new Map<string, Promise<unknown>>()
  return async function staleWhileRevalidate<T>(
    options: SwrOptions<T>
  ): Promise<{ data: T; state: CacheState }> {
    if (!(options.freshMs >= 0 && options.maxAgeMs > options.freshMs))
      throw new Error("Cache maxAgeMs must exceed freshMs.")
    if (!store) return { data: await options.load(), state: "bypass" }
    const key = swrCacheKey(options.namespace, options.scope, options.key)
    let cached: { data: T; createdAt: number } | undefined
    try {
      const raw = await store.get(key)
      if (raw) {
        const entry = JSON.parse(raw)
        if (
          entry.version === 1 &&
          Number.isFinite(entry.createdAt) &&
          "data" in entry &&
          entry.createdAt <= now() &&
          now() - entry.createdAt < options.maxAgeMs
        )
          cached = entry
      }
    } catch {
      /* Redis failure or invalid cache data must not break the route. */
    }
    const refresh = (background = false): Promise<{ data: T } | undefined> => {
      const pending = flights.get(key)
      if (pending) return pending as Promise<{ data: T } | undefined>
      const work = (async () => {
        const token = randomUUID()
        let locked = false
        try {
          locked = await store.lock(key, token, options.lockMs ?? 120_000, options.scope)
        } catch {
          /* Fail open. */
        }
        // Only one process refreshes a stale entry. Cold/forced reads can still
        // compute without a lease, but cannot overwrite the lease owner's value.
        if (!locked && background) return undefined
        const createdAt = now()
        try {
          const data = await options.load()
          if (locked) {
            const ttl = options.maxAgeMs - (now() - createdAt)
            if (ttl > 0) {
              try {
                const raw = JSON.stringify({ version: 1, createdAt, data })
                if (Buffer.byteLength(raw) <= (options.maxEntryBytes ?? 10 * 1024 * 1024))
                  await store.publish(key, token, raw, ttl, options.scope)
              } catch {
                /* Fresh data remains usable when cache writes fail. */
              }
            }
          }
          return { data }
        } finally {
          if (locked)
            try {
              await store.unlock(key, token)
            } catch {
              /* Lease expires. */
            }
        }
      })()
      flights.set(key, work)
      void work
        .finally(() => {
          if (flights.get(key) === work) flights.delete(key)
        })
        .catch(() => {})
      return work
    }
    if (cached && !options.force) {
      if (now() - cached.createdAt < options.freshMs)
        return { data: cached.data, state: "fresh" }
      options.defer(async () => {
        try {
          await refresh(true)
        } catch {
          /* Keep the original age and retry on a later request. */
        }
      })
      return { data: cached.data, state: "stale" }
    }
    const refreshed = await refresh()
    // A foreground request may join a background attempt that lost its lease.
    // Never let that race serve expired data or defeat a forced refresh.
    return {
      data: refreshed ? refreshed.data : await options.load(),
      state: options.force ? "bypass" : "miss",
    }
  }
}
