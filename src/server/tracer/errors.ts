import { ReadBudgetError } from "../semantic/read-budget"
import type { ApiErrorCode, JsonObject } from "@/src/lib/tracer/contracts"

const statusByCode: Record<ApiErrorCode, number> = {
  READ_BUSY: 429,
  READ_TIMEOUT: 504,
  READ_RESULT_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  EVALUATION_FAILED: 422,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
}

export class TracerError extends Error {
  readonly code: ApiErrorCode
  readonly details: JsonObject | undefined
  readonly status: number

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: { cause?: unknown; details?: JsonObject; status?: number }
  ) {
    super(message, { cause: options?.cause })
    this.name = "TracerError"
    this.code = code
    this.details = options?.details
    this.status = options?.status ?? statusByCode[code]
  }
}

export function asTracerError(
  error: unknown,
  fallbackMessage = "The local tracer could not complete this operation."
) {
  if (error instanceof ReadBudgetError)
    return new TracerError(
      error.code,
      error.message,
      error.code === "READ_BUSY"
        ? { details: { retryAfterSeconds: 1 } }
        : undefined
    )
  let cause: unknown = error
  for (
    let depth = 0;
    depth < 8 && cause instanceof Error;
    depth++, cause = cause.cause
  ) {
    if ("code" in cause && cause.code === "P4020")
      return new TracerError(
        "UNAUTHORIZED",
        "An active Cloud subscription is required. Open /billing.",
        { status: 402 }
      )
    if ("code" in cause && cause.code === "P4290") {
      let details: JsonObject = {
        reason: "RECORD_LIMIT_REACHED",
        billingUrl: "/billing",
      }
      if ("detail" in cause && typeof cause.detail === "string") {
        try {
          details = JSON.parse(cause.detail)
        } catch {
          /* Keep safe defaults. */
        }
      }
      return new TracerError(
        "VALIDATION_ERROR",
        "Monthly record limit reached. Upgrade your plan or wait for the next month. Existing data remains available.",
        { status: 429, details }
      )
    }
    if ("code" in cause && (cause.code === "57014" || cause.code === "55P03"))
      return new TracerError(
        "READ_TIMEOUT",
        "The query exceeded its read or lock deadline."
      )
  }
  if (error instanceof TracerError) {
    return error
  }

  return new TracerError("INTERNAL_ERROR", fallbackMessage, { cause: error })
}

export function notFound(resource: string, id: string) {
  return new TracerError("NOT_FOUND", `${resource} '${id}' was not found.`, {
    details: { id, resource },
  })
}

export function validation(message: string, details?: JsonObject) {
  return new TracerError("VALIDATION_ERROR", message, { details })
}
