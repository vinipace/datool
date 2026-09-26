import { createHash } from "node:crypto"
import { routeCacheRedis, pollingSwrCache } from "@/src/server/cache/redis"
import { stableCacheJson, type createStaleWhileRevalidate } from "@/src/server/cache/stale-while-revalidate"

type ReadResult<T> =
  | { unchanged: true; etag: string; state: string }
  | { unchanged: false; data: T; etag?: string; state: string }

/** Project-wide data only. Callers must authorize before every read, including 304s. */
export function createSharedReadCache(options: {
  cache: ReturnType<typeof createStaleWhileRevalidate>
  available?: () => boolean
}) {
  return async function read<T>(input: {
    projectId: string
    key: string
    etag?: string | null
    force?: boolean
    enabled?: boolean
    load: () => Promise<T>
  }): Promise<ReadResult<T>> {
    if (input.enabled === false || input.force || options.available?.() === false) {
      return { unchanged: false, data: await input.load(), state: "bypass" }
    }
    const result = await options.cache({
      namespace: "collection-read-response-v2", scope: input.projectId,
      key: input.key, freshMs: 1999, maxAgeMs: 2000, defer: () => {},
      // Polling payloads share Redis with durable queues. Large reads stay uncached.
      maxEntryBytes: 512 * 1024,
      load: async () => {
        const data = await input.load()
        // Hash the complete result after reading it. Independent score/progress
        // changes are covered without adding write triggers or a change log.
        const etag = `W/"${createHash("sha256").update(stableCacheJson({
          projectId: input.projectId, key: input.key, data,
        })).digest("hex")}"`
        return { data, etag }
      },
    })
    if (result.state === "bypass") {
      return { unchanged: false, data: result.data.data, state: "bypass" }
    }
    if (input.etag === result.data.etag) {
      return { unchanged: true, etag: result.data.etag, state: "unchanged" }
    }
    return { unchanged: false, ...result.data, state: result.state }
  }
}

let reader: ReturnType<typeof createSharedReadCache> | undefined
export function sharedReadCache() {
  reader ??= createSharedReadCache({
    cache: pollingSwrCache(),
    available: () => routeCacheRedis()?.status === "ready",
  })
  return reader
}
