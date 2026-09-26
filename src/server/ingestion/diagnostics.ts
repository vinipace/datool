import { TracerError } from "../tracer/errors"

export class IngestionDependencyPendingError extends Error {
  constructor() {
    super("Waiting for preceding ingestion event")
  }
}

const redisErrors = new Set([
  "OOM", "MISCONF", "READONLY", "NOAUTH", "WRONGPASS", "LOADING",
  "CLUSTERDOWN", "MASTERDOWN", "BUSY", "NOSCRIPT", "WRONGTYPE",
])
const connectionErrors = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
])

/** Never include messages, SQL, Redis commands, connection URLs, or event bodies. */
export function ingestionFailureCode(error: unknown): string {
  let current = error
  let fallback = "UNKNOWN"
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof IngestionDependencyPendingError) return "DEPENDENCY_PENDING"
    if (current instanceof IngestionPersistenceError) return current.failureCode
    if (current instanceof TracerError) fallback = current.code
    const code = "code" in current ? current.code : undefined
    if (typeof code === "string") {
      if (connectionErrors.has(code)) return code
      if (/^[0-9A-Z]{5}$/.test(code)) return `POSTGRES_${code}`
    }
    // Redis ReplyError has no code field; extract only a known protocol prefix.
    if (current.name === "ReplyError") {
      const prefix = current.message.split(" ", 1)[0]
      if (redisErrors.has(prefix)) return `REDIS_${prefix}`
    }
    current = current.cause
  }
  return fallback
}

/** BullMQ retains this safe message in Redis for operator inspection/replay. */
export class IngestionPersistenceError extends Error {
  readonly failureCode: string

  constructor(error: unknown) {
    const code = ingestionFailureCode(error)
    super(`Trace persistence pending (${code}); inspect ingestion dependencies and service availability`)
    this.failureCode = code
  }
}
