import { createHash } from "node:crypto"
import type { Redis } from "ioredis"
import type { SwrStore } from "./stale-while-revalidate"

export type PollingCacheLimits = { projectBytes: number; globalBytes: number }
export const pollingBudgetKeys = (prefix = "datool:swr:polling-budget-v1") =>
  [`${prefix}:expiry`, `${prefix}:entries`, `${prefix}:usage`] as const

export function pollingCacheLimits(env: Record<string, string | undefined> = process.env): PollingCacheLimits {
  const limit = (name: string, fallback: number) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!raw.trim() || !Number.isSafeInteger(value) || value < 0) return 0
    return value
  }
  return {
    projectBytes: limit("DATOOL_POLLING_CACHE_PROJECT_BYTES", 4 * 1024 * 1024),
    globalBytes: limit("DATOOL_POLLING_CACHE_GLOBAL_BYTES", 64 * 1024 * 1024),
  }
}

// One atomic admission/lease operation across every app process. Bookkeeping is
// charged with each item (4 KiB minimum); this is not a cap on Redis process RSS.
// Expired reservations are reclaimed in bounded batches. Conservative accounting
// after external deletion or failed writes can reduce hits, never extend freshness.
const script = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local expiry, entries, usage = KEYS[3], KEYS[4], KEYS[5]
local action, token, project = ARGV[1], ARGV[2], ARGV[3]
local ttl = tonumber(ARGV[4])
local projectLimit, globalLimit = tonumber(ARGV[5]), tonumber(ARGV[6])
local function release(id)
  local raw = redis.call('HGET', entries, id)
  if raw then
    local entry = cjson.decode(raw)
    local remaining = redis.call('HINCRBY', usage, entry[1], -entry[2])
    if remaining == 0 then redis.call('HDEL', usage, entry[1]) end
    redis.call('HINCRBY', usage, 'total', -entry[2])
    redis.call('HDEL', entries, id)
  end
  redis.call('ZREM', expiry, id)
end
for _, id in ipairs(redis.call('ZRANGEBYSCORE', expiry, '-inf', now, 'LIMIT', 0, 64)) do
  release(id)
end
local function expireMetadata()
  local latest = redis.call('ZREVRANGE', expiry, 0, 0, 'WITHSCORES')
  if #latest == 0 then
    redis.call('DEL', expiry, entries, usage)
  else
    local untilMs = tonumber(latest[2]) + 1000
    redis.call('PEXPIREAT', expiry, untilMs)
    redis.call('PEXPIREAT', entries, untilMs)
    redis.call('PEXPIREAT', usage, untilMs)
  end
end
local function reserve(id, bytes, untilMs)
  local old = redis.call('HGET', entries, id)
  local prior = old and cjson.decode(old) or nil
  if prior and prior[1] ~= project then return false end
  local delta = bytes - (prior and prior[2] or 0)
  local total = tonumber(redis.call('HGET', usage, 'total') or '0')
  local scoped = tonumber(redis.call('HGET', usage, project) or '0')
  if total + delta > globalLimit or scoped + delta > projectLimit then return false end
  -- Reserve before storing data: an interrupted/failed write overcounts safely.
  redis.call('HINCRBY', usage, 'total', delta)
  redis.call('HINCRBY', usage, project, delta)
  redis.call('HSET', entries, id, cjson.encode({project, bytes}))
  redis.call('ZADD', expiry, untilMs, id)
  expireMetadata()
  return true
end
if action == 'lock' then
  if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
  if not reserve(KEYS[2], 4096, now + ttl) then expireMetadata(); return 0 end
  redis.call('SET', KEYS[2], token, 'PXAT', now + ttl)
  return 1
end
if redis.call('GET', KEYS[2]) ~= token then expireMetadata(); return 0 end
if action == 'unlock' then
  redis.call('DEL', KEYS[2])
  release(KEYS[2])
  expireMetadata()
  return 1
end
-- A missing lease reservation must not publish an unaccounted response.
if not redis.call('HGET', entries, KEYS[2]) then return 0 end
local value = ARGV[7]
if #value > 524288 then return 0 end
local bytes = math.max(4096, math.ceil(#value * 1.25) + #KEYS[1] + 1024)
-- Keep the old value fully charged until replacement succeeds. A failed SET
-- must not undercount an older/larger value or shorten its reservation lifetime.
local previous = redis.call('HGET', entries, KEYS[1])
local priorBytes = previous and cjson.decode(previous)[2] or 0
local priorExpiry = tonumber(redis.call('ZSCORE', expiry, KEYS[1]) or '0')
if not reserve(KEYS[1], math.max(bytes, priorBytes), math.max(now + ttl, priorExpiry)) then
  expireMetadata(); return 0
end
redis.call('SET', KEYS[1], value, 'PXAT', now + ttl)
if priorBytes > bytes or priorExpiry > now + ttl then reserve(KEYS[1], bytes, now + ttl) end
return 1
`

/** Dedicated to short-lived polling data; dashboards and durable queues never enter this store. */
export function pollingCacheStore(
  redis: Redis,
  limits = pollingCacheLimits(),
  budgetPrefix?: string
): SwrStore {
  const budget = pollingBudgetKeys(budgetPrefix)
  // ioredis uses EVALSHA and reloads after Redis restarts, avoiding script text
  // on every miss. The script is constant across projects and budget settings.
  if (!("datoolPollingBudgetV1" in redis))
    redis.defineCommand("datoolPollingBudgetV1", { numberOfKeys: 5, lua: script })
  const scripted = redis as Redis & {
    datoolPollingBudgetV1(...args: (string | number)[]): Promise<number>
  }
  const run = (action: string, key: string, token: string, ttl: number, scope = "", value = "") =>
    scripted.datoolPollingBudgetV1(key, `${key}:lock`, ...budget, action, token,
      createHash("sha256").update(scope).digest("hex"), ttl,
      limits.projectBytes, limits.globalBytes, value)
  return {
    get: key => redis.get(key),
    lock: async (key, token, ttl, scope) =>
      (await run("lock", key, token, Math.min(ttl, 120_000), scope)) === 1,
    publish: async (key, token, value, ttl, scope) => {
      await run("publish", key, token, Math.min(ttl, 2000), scope, value)
    },
    unlock: async (key, token) => { await run("unlock", key, token, 0) },
  }
}
