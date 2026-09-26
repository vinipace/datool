import { createIngestionQueue, redisConnection } from "./queue"
import { ingestionFailureCode } from "./diagnostics"

type Queue = ReturnType<typeof createIngestionQueue>
const fields = (info: string) => Object.fromEntries(info.split(/\r?\n/).filter(line => line.includes(":"))
  .map(line => { const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 1)] }))

/** Bounded reads only; never export job payloads, identifiers, or credentials. */
export async function readIngestionHealth(queue: Queue, connection: ReturnType<typeof redisConnection>, now = Date.now()) {
  const [memoryText, persistenceText, sizes, lastCompleted, pendingIds] = await Promise.all([
    connection.info("memory"), connection.info("persistence"),
    Promise.all([connection.llen(queue.toKey("wait")), connection.llen(queue.toKey("active")),
      connection.zcard(queue.toKey("delayed")), connection.llen(queue.toKey("paused")),
      connection.zcard(queue.toKey("failed")), connection.zcard(queue.toKey("completed"))]),
    connection.zrevrange(queue.toKey("completed"), 0, 0, "WITHSCORES"),
    Promise.all([connection.lindex(queue.toKey("wait"), -1), connection.lindex(queue.toKey("active"), -1),
      connection.lindex(queue.toKey("paused"), -1), connection.zrange(queue.toKey("delayed"), 0, "0").then(ids => ids[0] ?? null)]),
  ])
  const counts = { waiting: sizes[0], active: sizes[1], delayed: sizes[2], paused: sizes[3], failed: sizes[4], completed: sizes[5] }
  const memory = fields(memoryText), persistence = fields(persistenceText)
  const usedBytes = Number(memory.used_memory), limitBytes = Number(memory.maxmemory)
  const memoryRatio = limitBytes > 0 ? usedBytes / limitBytes : null
  const pendingCount = counts.waiting + counts.active + counts.delayed + counts.paused
  const timestamps = (await Promise.all(pendingIds.filter((id): id is string => Boolean(id))
    .map(id => connection.hget(queue.toKey(id), "timestamp")))).map(Number).filter(value => value > 0)
  // Sample the oldest entry in each state. A recent completion demonstrates
  // progress; an old completion alone must not alarm on newly arriving work.
  const noProgressMs = pendingCount && timestamps.length
    ? Math.max(0, now - Math.max(Number(lastCompleted[1] ?? 0), Math.min(...timestamps))) : 0
  const critical: string[] = [], warnings: string[] = []
  if (memoryRatio !== null && memoryRatio >= 0.85) critical.push("REDIS_MEMORY_CRITICAL")
  else if (memoryRatio !== null && memoryRatio >= 0.7) warnings.push("REDIS_MEMORY_HIGH")
  if (!limitBytes) warnings.push("REDIS_LIMIT_UNSET")
  if (memory.maxmemory_policy !== "noeviction") critical.push("REDIS_EVICTION_ENABLED")
  if (persistence.aof_enabled !== "1") critical.push("REDIS_AOF_DISABLED")
  if (persistence.aof_last_write_status === "err" || persistence.aof_last_bgrewrite_status === "err") critical.push("REDIS_PERSISTENCE_ERROR")
  if (counts.failed) warnings.push("FAILED_EVENTS_RETAINED")
  if (noProgressMs >= 120_000) critical.push("INGESTION_NO_PROGRESS")
  return { event: "ingestion_health", severity: critical.length ? "CRITICAL" : warnings.length ? "WARNING" : "INFO",
    reasons: [...critical, ...warnings], usedBytes, limitBytes, memoryRatio,
    rssBytes: Number(memory.used_memory_rss), counts, noProgressMs }
}

/** Independent, fail-fast connection so a stuck worker cannot hide its health. */
export function startIngestionHealthMonitor() {
  const connection = redisConnection()
  const queue = createIngestionQueue(connection)
  connection.on("error", () => {})
  queue.on("error", () => {})
  let running: Promise<void> | undefined
  const tick = () => {
    if (running) return
    if (connection.status !== "ready") {
      console.error(JSON.stringify({ event: "ingestion_health", severity: "CRITICAL", reasons: ["REDIS_UNAVAILABLE"] }))
      return
    }
    running = readIngestionHealth(queue, connection)
      .then(health => { console.info(JSON.stringify(health)) })
      .catch(error => console.error(JSON.stringify({ event: "ingestion_health", severity: "CRITICAL", reasons: [ingestionFailureCode(error)] })))
      .finally(() => { running = undefined })
  }
  connection.once("ready", tick)
  const timer = setInterval(tick, 60_000)
  timer.unref()
  return async () => { clearInterval(timer); connection.disconnect(); await running; await queue.close() }
}
