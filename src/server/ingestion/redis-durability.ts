import type { Redis } from "ioredis"

/**
 * Accepted events can exist only in BullMQ until the worker persists them, so
 * Redis must never evict keys. Refuse to start against an evicting Redis.
 * Managed providers may block CONFIG; then only a warning is possible.
 */
export async function assertDurableRedis(
  connection: Pick<Redis, "config">,
  log: Pick<Console, "warn"> = console
) {
  let settings: Record<string, string>
  try {
    const read = async (name: string) => {
      const reply = (await connection.config("GET", name)) as string[]
      return reply[1] ?? ""
    }
    settings = {
      policy: await read("maxmemory-policy"),
      appendonly: await read("appendonly"),
    }
  } catch {
    log.warn(
      "Unable to read Redis CONFIG. Confirm maxmemory-policy=noeviction and durable persistence; an evicting Redis can lose accepted events."
    )
    return
  }
  if (settings.policy && settings.policy !== "noeviction")
    throw new Error(
      `Redis maxmemory-policy is '${settings.policy}'. Ingestion requires 'noeviction': evicted queue keys lose accepted events.`
    )
  if (settings.appendonly && settings.appendonly !== "yes")
    log.warn(
      "Redis appendonly is disabled. Accepted events that are not yet persisted can be lost if Redis restarts."
    )
}
