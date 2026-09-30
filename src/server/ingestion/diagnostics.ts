import { createHash } from "node:crypto"
import { UnrecoverableError, type Job } from "bullmq"
import { z } from "zod"
import { TracerError } from "../tracer/errors"
import type { IngestionJob } from "./queue"
import type { IngestionEvent } from "./events"

const stages = [
  "unknown",
  "validate_event",
  "database",
  "begin_transaction",
  "lock_event",
  "read_receipt",
  "check_dependency",
  "apply_event",
  "save_receipt",
  "commit_transaction",
  "worker",
  "enqueue",
  "health",
  "cleanup",
] as const
export type IngestionStage = (typeof stages)[number]
const sourcePattern =
  /^(?:src|scripts|app|lib|tests|node_modules)\/[A-Za-z0-9_@./-]+\.[cm]?[jt]sx?:\d+:\d+$/
const names = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "TracerError",
  "ReplyError",
  "IngestionDependencyPendingError",
  "UnrecoverableError",
  "NonError",
] as const
const diagnosticSchema = z
  .object({
    version: z.literal(1),
    code: z.string().regex(/^(?:[A-Z][A-Z0-9_]{0,63})$/),
    stage: z.enum(stages),
    retryable: z.boolean(),
    release: z
      .string()
      .regex(/^[a-f0-9]{7,64}$/i)
      .nullable(),
    status: z.number().int().min(100).max(599).optional(),
    detail: z.enum(["RECORD_LIMIT_REACHED"]).optional(),
    causes: z
      .array(
        z
          .object({
            type: z.enum(names),
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            frames: z.array(z.string().max(240).regex(sourcePattern)).max(4),
          })
          .strict()
      )
      .max(4),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type IngestionDiagnostic = z.infer<typeof diagnosticSchema>

const summaries: Record<string, string> = {
  DEPENDENCY_PENDING: "The preceding event has no committed receipt yet.",
  VALIDATION_ERROR:
    "The lifecycle operation failed validation; inspect its stage and source frames.",
  CONFLICT:
    "The event or resource conflicts with existing data; inspect its receipt and source frames.",
  UNAUTHORIZED: "The operation failed an authorization or subscription check.",
  NOT_FOUND: "A referenced resource was not found.",
  RECORD_LIMIT_REACHED: "The project's monthly record limit was reached.",
  UNKNOWN:
    "An unclassified error occurred; use its stage, source frames and fingerprint to investigate.",
}
export function diagnosticSummary(
  diagnostic: Pick<IngestionDiagnostic, "code" | "detail">
) {
  return (
    summaries[diagnostic.detail ?? diagnostic.code] ??
    (diagnostic.code.startsWith("POSTGRES_")
      ? "PostgreSQL rejected the operation; inspect the SQLSTATE and source frames."
      : diagnostic.code.startsWith("REDIS_")
        ? "Redis rejected the operation; inspect the protocol error code."
        : "The operation failed; inspect the error code, stage and source frames.")
  )
}

function sourceFrames(error: Error) {
  // Exclude the message, function names, absolute prefixes, URLs and query strings.
  const stack = error.stack?.startsWith(error.toString())
    ? error.stack.slice(error.toString().length)
    : ""
  return stack
    .split("\n")
    .slice(0, 25)
    .flatMap((line) => {
      const location = line.match(
        /(?:\(|\s)(?:file:\/\/)?\/?[^\s()?#]*?((?:src|scripts|app|lib|tests|node_modules)\/[A-Za-z0-9_@./-]+\.[cm]?[jt]sx?:\d+:\d+)\)?$/
      )?.[1]
      const relative = location?.replace(
        /^app\/(?=(?:src|scripts|app|lib|tests|node_modules)\/)/,
        ""
      )
      return relative && relative.length <= 240 && sourcePattern.test(relative)
        ? [relative]
        : []
    })
    .slice(0, 4)
}

function errorChain(error: unknown) {
  const result: Error[] = [],
    seen = new Set<unknown>()
  for (
    let current = error;
    current instanceof Error && !seen.has(current) && result.length < 4;
    current = current.cause
  ) {
    seen.add(current)
    result.push(current)
  }
  return result
}

export function describeIngestionError(
  error: unknown,
  stage: IngestionStage = "unknown",
  retryable = true
): IngestionDiagnostic {
  if (
    error instanceof IngestionPersistenceError ||
    error instanceof IngestionRejectedError
  )
    return error.diagnostic
  const chain = errorChain(error)
  const tracer = chain.find(
    (cause): cause is TracerError => cause instanceof TracerError
  )
  const code = ingestionFailureCode(error)
  const causes = chain.map((cause) => ({
    type: (names as readonly string[]).includes(cause.name)
      ? (cause.name as (typeof names)[number])
      : ("Error" as const),
    code: ingestionFailureCode(cause),
    frames: sourceFrames(cause),
  }))
  if (!causes.length) causes.push({ type: "NonError", code, frames: [] })
  const detail =
    tracer?.details?.reason === "RECORD_LIMIT_REACHED"
      ? ("RECORD_LIMIT_REACHED" as const)
      : undefined
  const context = {
    code,
    stage,
    retryable,
    status: tracer?.status,
    detail,
    causes,
  }
  return {
    version: 1,
    ...context,
    release: ingestionRelease(),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(context))
      .digest("hex"),
  }
}

/** Only our bounded structured envelope is printable; legacy messages may contain customer data. */
export function readRetainedDiagnostic(
  reason: string | undefined
): IngestionDiagnostic | null {
  if (!reason || reason.length > 16_384) return null
  try {
    const result = diagnosticSchema.safeParse(JSON.parse(reason))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
export function isRecordLimitFailure(reason: string | undefined) {
  return (
    reason?.startsWith("Monthly record limit reached.") ||
    readRetainedDiagnostic(reason)?.detail === "RECORD_LIMIT_REACHED"
  )
}

export function ingestionContext(
  job: Pick<Job<IngestionJob>, "id" | "data" | "attemptsMade" | "opts">
) {
  return {
    jobId: diagnosticId(job.id),
    ...ingestionEventContext(job.data.projectId, job.data.event),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
  }
}
export function ingestionEventContext(
  projectId: string,
  event: IngestionEvent
) {
  const path = typeof event?.path === "string" ? event.path : ""
  const target = /^\/api\/(traces|spans)\/([^/]+)(\/spans)?$/.exec(path)
  const operation = ["/api/traces", "/api/spans", "/api/sessions"].includes(
    path
  )
    ? path
    : target
      ? `/api/${target[1]}/:id${target[3] ?? ""}`
      : "unsupported"
  const bodyId =
    event?.body && typeof event.body === "object" && "id" in event.body
      ? event.body.id
      : undefined
  return {
    projectId: diagnosticId(projectId),
    eventId: diagnosticId(event?.id),
    previousEventId: diagnosticId(event?.previousId),
    operation,
    method:
      event?.method === "POST" || event?.method === "PATCH"
        ? event.method
        : "unsupported",
    targetId: diagnosticId(bodyId ?? target?.[2]),
    parentTraceId: target?.[3] ? diagnosticId(target[2]) : null,
  }
}
function diagnosticId(value: unknown): string | null {
  if (typeof value !== "string") return null
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)
    ? value
    : `sha256:${createHash("sha256").update(value).digest("hex")}`
}
export function ingestionRelease() {
  const value =
    process.env.DATOOL_RELEASE ??
    process.env.GIT_REV ??
    process.env.SOURCE_VERSION
  return value && /^[a-f0-9]{7,64}$/i.test(value) ? value : null
}

export function ingestionFailureLog(
  job: Job<IngestionJob> | undefined,
  error: Error
) {
  const terminal =
    error instanceof UnrecoverableError ||
    error.name === "UnrecoverableError" ||
    Boolean(job?.finishedOn) ||
    Boolean(job && job.attemptsMade >= (job.opts.attempts ?? 1))
  if (job && job.attemptsMade !== 1 && !terminal) return null
  const diagnostic = describeIngestionError(error, "worker", !terminal)
  return {
    event: "ingestion_failed",
    severity: terminal ? "ERROR" : "WARNING",
    release: ingestionRelease(),
    ...(job ? ingestionContext(job) : {}),
    terminal,
    reason: diagnostic.code,
    summary: diagnosticSummary(diagnostic),
    diagnostic,
  }
}

export class IngestionDependencyPendingError extends Error {
  constructor() {
    super("Waiting for preceding ingestion event")
  }
}

const redisErrors = new Set([
  "OOM",
  "MISCONF",
  "READONLY",
  "NOAUTH",
  "WRONGPASS",
  "LOADING",
  "CLUSTERDOWN",
  "MASTERDOWN",
  "BUSY",
  "NOSCRIPT",
  "WRONGTYPE",
])
const connectionErrors = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
])

/** Never include messages, SQL, Redis commands, connection URLs, or event bodies. */
export function ingestionFailureCode(error: unknown): string {
  let current = error
  let fallback = "UNKNOWN"
  const seen = new Set<unknown>()
  for (
    let depth = 0;
    depth < 8 && current instanceof Error && !seen.has(current);
    depth++
  ) {
    seen.add(current)
    if (current instanceof IngestionDependencyPendingError)
      return "DEPENDENCY_PENDING"
    if (
      current instanceof IngestionPersistenceError ||
      current instanceof IngestionRejectedError
    )
      return current.failureCode
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
  readonly diagnostic: IngestionDiagnostic

  constructor(error: unknown, stage: IngestionStage = "unknown") {
    const diagnostic = describeIngestionError(error, stage, true)
    super(JSON.stringify(diagnostic))
    this.failureCode = diagnostic.code
    this.diagnostic = diagnostic
  }
}

export class IngestionRejectedError extends UnrecoverableError {
  readonly failureCode: string
  readonly diagnostic: IngestionDiagnostic

  constructor(error: unknown, stage: IngestionStage) {
    const diagnostic = describeIngestionError(error, stage, false)
    super(JSON.stringify(diagnostic))
    this.failureCode = diagnostic.code
    this.diagnostic = diagnostic
  }
}
