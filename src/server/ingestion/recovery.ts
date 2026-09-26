import type { createIngestionQueue, redisConnection } from "./queue"

// Safe even at maxmemory: it only shrinks a diagnostic field and verifies both
// the failed state and the exact observed value atomically against replay races.
const compact = `#!lua flags=allow-oom
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
if redis.call('HGET', KEYS[2], 'stacktrace') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'stacktrace', ARGV[3])
return 1`

/** Keep the latest stack. Never remove or replay an event, or alter its payload. */
export async function compactFailedIngestionStacks(queue: ReturnType<typeof createIngestionQueue>, connection: ReturnType<typeof redisConnection>, cursor = "0") {
  if (!/^\d+$/.test(cursor)) throw new Error("A numeric scan cursor is required")
  const [nextCursor, entries] = await connection.zscan(queue.toKey("failed"), cursor, "COUNT", 100)
  let compacted = 0, bytesRemoved = 0
  for (let index = 0; index < entries.length; index += 2) {
    const id = entries[index], key = queue.toKey(id)
    const before = await connection.hget(key, "stacktrace")
    if (!before) continue
    let stacks: unknown
    try { stacks = JSON.parse(before) } catch { continue }
    if (!Array.isArray(stacks) || stacks.length <= 1 || typeof stacks.at(-1) !== "string") continue
    const after = JSON.stringify([stacks.at(-1)])
    if (Buffer.byteLength(after) >= Buffer.byteLength(before)) continue
    if (await connection.eval(compact, 2, queue.toKey("failed"), key, id, before, after)) {
      compacted++
      bytesRemoved += Buffer.byteLength(before) - Buffer.byteLength(after)
    }
  }
  return { cursor: nextCursor, compacted, bytesRemoved }
}
