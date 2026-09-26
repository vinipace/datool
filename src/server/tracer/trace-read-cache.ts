import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import { routeCacheRedis, pollingSwrCache } from "@/src/server/cache/redis"
import { stableCacheJson, type createStaleWhileRevalidate } from "@/src/server/cache/stale-while-revalidate"

type Cache = ReturnType<typeof createStaleWhileRevalidate>
export type TraceReadCacheMode = "off" | "version" | "shared" | "combined"
export type TraceReadResult<T> =
  | { unchanged: true; etag: string; state: string }
  | { unchanged: false; data: T; etag?: string; state: string }

/** Caller MUST authorize the project before invoking this cache. */
export function createTraceReadCache(options: {
  cache: Cache
  revision: (projectId: string) => Promise<string>
  available?: () => boolean
  now?: () => number
}) {
  const now = options.now ?? Date.now
  return async function read<T>(input: {
    projectId: string
    key: unknown
    versioned: boolean
    etag?: string | null
    force?: boolean
    mode?: TraceReadCacheMode
    load: () => Promise<T>
  }): Promise<TraceReadResult<T>> {
    const mode = input.mode ?? "combined"
    const bypass = async (): Promise<TraceReadResult<T>> => ({
      unchanged: false, data: await input.load(), state: "bypass",
    })
    if (mode === "off" || input.force || options.available?.() === false) return bypass()
    let etag: string | undefined
    if (input.versioned && mode !== "shared") {
      try {
        // Redis is an acceleration layer, not the only record of a change.
        // Refresh from committed PostgreSQL state at least once per second.
        const revision = await options.cache({
          namespace: "trace-read-revision-v2", scope: input.projectId, key: null,
          freshMs: 999, maxAgeMs: 1000, defer: () => {},
          load: () => options.revision(input.projectId),
        })
        // An unavailable Redis cache must never produce an unchanged response.
        if (revision.state === "bypass") return bypass()
        // Rolling time filters expire even without writes. Also bounds all
        // client validators, independently of process lifetimes / Redis resets.
        etag = `W/"${createHash("sha256").update(stableCacheJson({
          projectId: input.projectId, key: input.key, revision: revision.data,
          window: Math.floor(now() / 30_000),
        })).digest("hex")}"`
        if (input.etag === etag) return { unchanged: true, etag, state: "unchanged" }
      } catch {
        // Missing migration, database/Redis errors: retain ordinary read behavior.
        return bypass()
      }
    }
    if (mode === "version") {
      return { unchanged: false, data: await input.load(), etag, state: "miss" }
    }
    const result = await options.cache({
      namespace: "trace-read-response-v2", scope: input.projectId,
      key: input.key, freshMs: 1999, maxAgeMs: 2000, defer: () => {},
      // Polling payloads share Redis with durable queues. Large reads stay uncached.
      maxEntryBytes: 512 * 1024,
      // Keep the validator paired with the data load that produced it. In
      // particular, never label a cached response with a newer project version.
      load: async () => ({ data: await input.load(), etag }),
    })
    return { unchanged: false, ...result.data, state: result.state }
  }
}

let reader: ReturnType<typeof createTraceReadCache> | undefined
export function traceReadCache() {
  reader ??= createTraceReadCache({
    cache: pollingSwrCache(),
    available: () => routeCacheRedis()?.status === "ready",
    revision: async projectId => {
      const result = await db.query<{ revision: string }>(
        "SELECT md5(string_agg(bucket::text || ':' || revision::text, ',' ORDER BY bucket)) AS revision FROM trace_read_revisions WHERE project_id = $1", [projectId],
      )
      return result.rows[0]?.revision ?? "empty"
    },
  })
  return reader
}

export function traceReadCacheMode(): TraceReadCacheMode {
  const mode = process.env.DATOOL_TRACE_READ_CACHE
  return mode === "off" || mode === "version" || mode === "shared" ? mode : "combined"
}
