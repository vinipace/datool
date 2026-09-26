import { createHash, randomUUID } from "node:crypto"
import type { Redis } from "ioredis"
import type { ManagedPrompt } from "@/src/lib/tracer/prompts"
import { routeCacheRedis } from "@/src/server/cache/redis"

const MAX_AGE_MS = 60_000
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
type Lookup = { id: string; bySlug: boolean; version?: number }

function keys(projectId: string, lookup?: Lookup) {
  // Hash tags keep both keys in the same Redis Cluster slot. Never include keys
  // or credentials in the cache namespace; authorization happens before reads.
  const scope = createHash("sha256").update(projectId).digest("hex")
  const prefix = `datool:prompts:v1:{${scope}}`
  return {
    generation: `${prefix}:generation`,
    entry: `${prefix}:${createHash("sha256")
      .update(JSON.stringify(lookup ?? null))
      .digest("hex")}`,
  }
}

/** Shared runtime cache, with process-local coalescing of concurrent misses. */
export function createPromptCache(redis: Redis | null, now = Date.now) {
  const flights = new Map<string, Promise<ManagedPrompt>>()
  return {
    async get(
      projectId: string,
      lookup: Lookup,
      load: () => Promise<ManagedPrompt>
    ) {
      if (!redis || redis.status !== "ready") return load()
      const key = keys(projectId, lookup)
      let generation: string
      try {
        // Read the generation and value atomically, in one Redis round trip.
        const result = (await redis.eval(
          "return {redis.call('get', KEYS[1]) or '', redis.call('get', KEYS[2]) or ''}",
          2,
          key.generation,
          key.entry
        )) as [string, string]
        generation = result[0]
        if (result[1]) {
          const entry = JSON.parse(result[1])
          if (
            entry.generation === generation &&
            Number.isFinite(entry.createdAt) &&
            entry.createdAt <= now() &&
            now() - entry.createdAt < MAX_AGE_MS &&
            entry.data?.id &&
            Number.isSafeInteger(entry.data.version)
          )
            return entry.data as ManagedPrompt
        }
      } catch {
        // No stale fallback: database authorization/deletion semantics still win.
        return load()
      }
      const flightKey = `${key.entry}:${generation}`
      let pending = flights.get(flightKey)
      if (!pending) {
        const createdAt = now()
        pending = (async () => {
          const data = await load()
          const remaining = MAX_AGE_MS - (now() - createdAt)
          if (remaining > 0) {
            try {
              const raw = JSON.stringify({ generation, createdAt, data })
              if (Buffer.byteLength(raw) <= MAX_ENTRY_BYTES) {
                // An earlier database read cannot refill the cache after a
                // committed mutation invalidates this project on another worker.
                await redis.eval(
                  `if (redis.call('get', KEYS[1]) or '') == ARGV[1] then
                    return redis.call('psetex', KEYS[2], ARGV[2], ARGV[3]) end
                    return 0`,
                  2,
                  key.generation,
                  key.entry,
                  generation,
                  remaining,
                  raw
                )
              }
            } catch {
              // A cache write failure must not fail a successful database read.
            }
          }
          return data
        })()
        flights.set(flightKey, pending)
        void pending
          .finally(() => {
            if (flights.get(flightKey) === pending) flights.delete(flightKey)
          })
          .catch(() => {})
      }
      // In-process consumers cannot mutate another caller's response.
      return structuredClone(await pending)
    },
    async invalidate(projectId: string) {
      if (!redis || redis.status !== "ready") return
      try {
        // Outlive every possible entry/read so expiration cannot reuse an old
        // generation. Old values expire individually without a key scan.
        await redis.set(
          keys(projectId).generation,
          randomUUID(),
          "PX",
          MAX_AGE_MS * 2
        )
      } catch {
        // Mutations remain available during Redis outages. Entries have a hard
        // one-minute age limit, including time spent loading from PostgreSQL.
      }
    },
  }
}

export type PromptCache = ReturnType<typeof createPromptCache>
let cache: PromptCache | undefined
export function runtimePromptCache() {
  return (cache ??= createPromptCache(routeCacheRedis()))
}
