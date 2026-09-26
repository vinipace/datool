import { ReadBudgetError } from "./read-budget"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"
import { SemanticQueryValidationError } from "@/src/lib/semantic/query"
import { SemanticResultValidationError } from "@/src/lib/semantic/result"
import { asTracerError, TracerError } from "@/src/server/tracer/errors"
import { SemanticExecutionError } from "@/src/server/semantic/executor"

export class SemanticUnexpectedError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super("The semantic metrics service could not complete this operation.", {
      cause,
    })
    this.name = "SemanticUnexpectedError"
    this.cause = cause
  }
}

export type SemanticServiceError =
  | ReadBudgetError
  | SemanticExecutionError
  | SemanticModelQueryError
  | SemanticQueryValidationError
  | SemanticResultValidationError
  | SemanticUnexpectedError

export function toSemanticServiceError(error: unknown): SemanticServiceError {
  if (
    error instanceof ReadBudgetError ||
    error instanceof SemanticExecutionError ||
    error instanceof SemanticModelQueryError ||
    error instanceof SemanticQueryValidationError ||
    error instanceof SemanticResultValidationError ||
    error instanceof SemanticUnexpectedError
  ) {
    return error
  }
  let cause = error
  for (let i = 0; i < 5 && cause instanceof Error; i++) {
    if (cause instanceof ReadBudgetError) return cause
    if ("code" in cause && cause.code === "57014")
      return new ReadBudgetError(
        "READ_TIMEOUT",
        "The query exceeded its read deadline."
      )
    cause = cause.cause
  }
  return new SemanticUnexpectedError(error)
}

/** Convert the bounded semantic error protocol into Datool's existing API envelope. */
export function semanticErrorToTracerError(
  error: SemanticServiceError
): TracerError {
  if (error instanceof ReadBudgetError) return asTracerError(error)
  if (error instanceof SemanticQueryValidationError) {
    return new TracerError("VALIDATION_ERROR", error.message, {
      details: {
        issues: error.issues.map(issueToJson),
        semanticCode: error.code,
      },
    })
  }
  if (
    error instanceof SemanticExecutionError ||
    error instanceof SemanticModelQueryError
  ) {
    return new TracerError("VALIDATION_ERROR", error.message, {
      details: {
        path: [...error.path],
        semanticCode: error.code,
      },
    })
  }
  if (error instanceof SemanticResultValidationError) {
    return new TracerError(
      "INTERNAL_ERROR",
      "The semantic metric model returned an invalid result.",
      {
        cause: error,
        details: {
          issues: error.issues.map(issueToJson),
          semanticCode: error.code,
        },
      }
    )
  }
  return new TracerError(
    "INTERNAL_ERROR",
    "The semantic metrics service could not complete this operation.",
    {
      cause: error.cause,
    }
  )
}

function issueToJson(issue: {
  code: string
  message: string
  path: readonly (string | number)[]
}): JsonObject {
  return {
    code: issue.code,
    message: issue.message,
    path: [...issue.path] as JsonValue,
  }
}
