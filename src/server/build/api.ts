import { z } from "zod"
import { WhatsAppApiError } from "./channels/whatsapp-api"

import type { BuildScope } from "@/src/lib/auth/permissions"
import { workspaceIdentity } from "@/src/server/auth/context"
import { getBuildContext, type BuildContext } from "./context"
import { buildEnabled } from "@/lib/build/config"
import { sanitizePublicActionResult } from "./definitions"
import {
  beginBuildOperationReceiptInTransaction,
  completeBuildOperationReceipt,
} from "./receipts"
import { TracerError, validation } from "@/src/server/tracer/errors"
import { scopedTracerTransaction } from "@/src/server/tracer/db"

export { getBuildContext } from "./context"

export type { BuildContext } from "./context"

/** A Build write can be retried only when its owner supplies a stable key. */
export type BuildIdempotency = "none" | "optional" | "required"
export type BuildRevisionPolicy = "none" | "optional" | "required"

export type BuildOperation = {
  /** Operation names are shared by REST, MCP discovery and the CLI. */
  name: string
  description: string
  scopes: readonly BuildScope[]
  schema: z.ZodObject<z.ZodRawShape>
  outputSchema?: z.ZodTypeAny
  destructive?: boolean
  /** Whether an MCP client may safely replay this operation. */
  idempotent?: boolean
  /** Whether execution can call a customer system or other external service. */
  openWorld?: boolean
  idempotency?: BuildIdempotency
  expectedRevision?: BuildRevisionPolicy
  /** Maximum JSON request size accepted by the HTTP transport for this operation. */
  maxInputBytes?: number
  execute: (
    context: BuildContext & {
      requestKey?: string
      idempotencyKey?: string
    },
    input: Record<string, unknown>
  ) => unknown | Promise<unknown>
}

const operations: BuildOperation[] = []

/** The authoritative registry consumed by all Build transports. */
export const buildOperations: readonly BuildOperation[] = operations

function operationName(name: string) {
  return /^build_[a-z][a-z0-9_]{1,119}$/.test(name)
}

function operationScopes(scopes: readonly BuildScope[]) {
  if (!scopes.length) throw new Error("A Build operation must declare a scope.")
  if (
    scopes.some(
      (scope) => !["build:read", "build:write", "build:run"].includes(scope)
    )
  )
    throw new Error(
      "Build operations may only use build:read, build:write or build:run."
    )
}

const buildScopeNames = ["build:read", "build:write", "build:run"] as const
function hasAnyBuildScope(scopes: readonly string[] | undefined) {
  return Boolean(
    scopes?.some((scope) => buildScopeNames.includes(scope as BuildScope))
  )
}

/**
 * Register a typed operation once. Domain modules own their handlers; this
 * registry owns naming, permission metadata and transport parity.
 */
export function registerBuildOperation(operation: BuildOperation) {
  if (!operationName(operation.name))
    throw new Error(
      "Build operation names must begin with build_ and use lowercase snake_case."
    )
  operationScopes(operation.scopes)
  if (
    operation.maxInputBytes !== undefined &&
    (!Number.isInteger(operation.maxInputBytes) ||
      operation.maxInputBytes < 1024 ||
      operation.maxInputBytes > 64 * 1024 * 1024)
  )
    throw new Error(
      "Build operation maxInputBytes must be an integer from 1 KiB to 64 MiB."
    )
  if (operations.some((candidate) => candidate.name === operation.name))
    throw new Error(
      `Build operation '${operation.name}' is already registered.`
    )
  const idempotency =
    operation.idempotency ??
    (operation.scopes.some((scope) => scope !== "build:read")
      ? "optional"
      : "none")
  operations.push({
    ...operation,
    scopes: [...operation.scopes],
    idempotency,
    expectedRevision: operation.expectedRevision ?? "none",
    destructive: operation.destructive ?? false,
    idempotent:
      operation.idempotent ??
      operation.scopes.every((scope) => scope === "build:read"),
    openWorld: operation.openWorld ?? false,
    maxInputBytes: operation.maxInputBytes,
  })
  return operation
}

export function registerBuildOperations(registered: readonly BuildOperation[]) {
  for (const operation of registered) registerBuildOperation(operation)
}

export function findBuildOperation(name: string) {
  return operations.find((operation) => operation.name === name)
}

/**
 * The single transport input contract used by the REST catalog and MCP
 * discovery. Transport retry aliases stay outside every domain schema while
 * remaining visible to callers that need to supply them.
 */
export function buildOperationInputSchema(operation: BuildOperation) {
  return operation.schema
    .extend(
      operation.idempotency !== "none"
        ? {
            idempotencyKey: z.string().trim().min(1).max(200).optional(),
            requestKey: z.string().trim().min(1).max(200).optional(),
          }
        : {}
    )
    .strict()
}

export function buildOperationCatalog(scopes?: readonly string[]) {
  return operations
    .filter(
      (operation) =>
        !scopes ||
        (operation.name === "build_describe_operations"
          ? hasAnyBuildScope(scopes)
          : operation.scopes.every((scope) => scopes.includes(scope)))
    )
    .map((operation) => ({
      name: operation.name,
      description: operation.description,
      scopes: operation.scopes,
      destructive: operation.destructive ?? false,
      idempotent: operation.idempotent ?? false,
      idempotency: operation.idempotency ?? "none",
      expectedRevision: operation.expectedRevision ?? "none",
      maxInputBytes: operation.maxInputBytes ?? 1024 * 1024,
      inputSchema: z.toJSONSchema(buildOperationInputSchema(operation), {
        io: "input",
      }),
    }))
}

export type BuildExecutionOptions = {
  requestKey?: string
  idempotencyKey?: string
}

function transportKey(value: unknown, maxLength = 200) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length > maxLength)
    throw validation(
      `Build request keys must be at most ${maxLength} characters.`
    )
  return trimmed ? trimmed : undefined
}

function safeInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw validation("Build operation input must be a JSON object.")
  return input as Record<string, unknown>
}

function normalizeBuildError(error: unknown): TracerError {
  if (error instanceof TracerError) return error
  for (
    let cause = error, depth = 0;
    cause instanceof Error && depth < 8;
    cause = cause.cause, depth++
  ) {
    if ("code" in cause && (cause.code === "42P01" || cause.code === "42703"))
      return new TracerError(
        "INTERNAL_ERROR",
        "Build requires a database upgrade. Ask your administrator to run the pending database migrations.",
        {
          status: 503,
          details: { reason: "BUILD_SCHEMA_NOT_READY" },
          cause: error,
        }
      )
  }
  if (error instanceof WhatsAppApiError)
    return new TracerError("VALIDATION_ERROR", error.message, { status: error.code === "RATE_LIMITED" ? 429 : error.uncertain || error.code === "NETWORK_ERROR" || error.code === "PROVIDER_UNAVAILABLE" ? 502 : 400, details: { reason: error.code } })
  if (!(error instanceof Error))
    return new TracerError("INTERNAL_ERROR", "Build operation failed.")

  const value = error as Error & {
    code?: unknown
    status?: unknown
    details?: unknown
  }
  const code =
    value.code === "NOT_FOUND" ||
    value.code === "CONFLICT" ||
    value.code === "UNAUTHORIZED" ||
    value.code === "VALIDATION_ERROR"
      ? value.code
      : value.code === "VALIDATION"
        ? "VALIDATION_ERROR"
        : typeof value.status === "number" && value.status === 404
          ? "NOT_FOUND"
          : typeof value.status === "number" && value.status === 409
            ? "CONFLICT"
            : typeof value.status === "number" && value.status === 401
              ? "UNAUTHORIZED"
              : "INTERNAL_ERROR"
  const status =
    typeof value.status === "number" &&
    value.status >= 400 &&
    value.status <= 599
      ? value.status
      : undefined
  const details =
    value.details &&
    typeof value.details === "object" &&
    !Array.isArray(value.details)
      ? (value.details as Record<string, never>)
      : undefined
  return new TracerError(
    code,
    code === "INTERNAL_ERROR" ? "Build operation failed." : value.message,
    {
      status,
      details,
      cause: error,
    }
  )
}

function validateBuildResult(
  operation: BuildOperation,
  name: string,
  result: unknown
) {
  if (!operation.outputSchema) return result
  const output = operation.outputSchema.safeParse(result)
  if (!output.success)
    throw new TracerError(
      "INTERNAL_ERROR",
      `Build operation '${name}' returned an invalid result.`
    )
  return output.data
}

function sanitizeBuildResult(operation: BuildOperation, result: unknown) {
  return operation.name === "build_save_action"
    ? sanitizePublicActionResult(result)
    : result
}

/**
 * Execute a keyed database mutation and its replay receipt in one PostgreSQL
 * transaction. A process crash rolls back both the domain mutation and its
 * pending receipt, so the next request can safely run again.
 */
async function executeAtomicBuildOperation(
  operation: BuildOperation,
  context: BuildContext,
  input: Record<string, unknown>,
  idempotencyKey: string
) {
  return context.database.transaction(async (tx) => {
    const database = scopedTracerTransaction(context.database, tx)
    const transactionContext = { ...context, database }
    const receipt = await beginBuildOperationReceiptInTransaction(
      transactionContext,
      operation.name,
      idempotencyKey,
      input
    )
    if (receipt.kind === "replay")
      return validateBuildResult(
        operation,
        operation.name,
        sanitizeBuildResult(operation, receipt.result)
      )

    // Failure rolls back both the mutation and receipt. The shared dispatcher
    // normalizes the error after this transaction closes.
    const result = await operation.execute(transactionContext, input)
    const output = sanitizeBuildResult(
      operation,
      validateBuildResult(operation, operation.name, result)
    )
    await completeBuildOperationReceipt(transactionContext, receipt.id, output)
    return output
  })
}

/** Execute the registered operation inside the caller's authorized workspace. */
export async function executeBuildOperation(
  name: string,
  input: unknown,
  options: BuildExecutionOptions = {}
) {
  const operation = findBuildOperation(name)
  if (!buildEnabled())
    throw new TracerError("NOT_FOUND", "Build is disabled on this installation.")
  if (!operation)
    throw new TracerError(
      "NOT_FOUND",
      `Build operation '${name}' was not found.`,
      {
        details: { operation: name },
      }
    )
  // Check the caller's grant before parsing input or opening a project
  // database handle. This keeps denied calls fail-closed even when the
  // installation has no database connection configured, and protects direct
  // and CLI callers that bypass HTTP.
  const grantedScopes = workspaceIdentity()?.scopes
  const scopeSatisfied =
    operation.name === "build_describe_operations"
      ? hasAnyBuildScope(grantedScopes)
      : operation.scopes.every((scope) => grantedScopes?.includes(scope))
  const missingScopes = scopeSatisfied
    ? []
    : operation.name === "build_describe_operations"
      ? ["build:read|build:write|build:run"]
      : operation.scopes.filter((scope) => !grantedScopes?.includes(scope))
  if (!scopeSatisfied)
    throw new TracerError(
      "UNAUTHORIZED",
      `Missing required permission: ${missingScopes.join(", ")}.`,
      { status: 403, details: { reason: "INSUFFICIENT_SCOPE", missingScopes } }
    )
  const candidate = safeInput(input)
  const requestKey =
    transportKey(options.requestKey) ?? transportKey(candidate.requestKey)
  const idempotencyKey =
    transportKey(options.idempotencyKey) ??
    transportKey(candidate.idempotencyKey) ??
    requestKey
  const schemaInput = { ...candidate }
  delete schemaInput.requestKey
  delete schemaInput.idempotencyKey
  const parsed = operation.schema.strict().safeParse(schemaInput)
  if (!parsed.success)
    throw validation(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")
    )

  const value = parsed.data as Record<string, unknown>
  const expectedRevision = value.expectedRevision
  if (
    operation.expectedRevision === "required" &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1)
  )
    throw validation("expectedRevision must be a positive integer.")

  if (operation.idempotency === "required" && !idempotencyKey)
    throw validation("An idempotency key is required for this Build operation.")

  // requestKey and idempotencyKey are transport aliases. Preserve both
  // values for legacy conversation turns while giving every keyed mutation a
  // single durable replay key.
  const context = getBuildContext({
    requestKey: requestKey ?? idempotencyKey,
    idempotencyKey,
  })
  if (
    operation.name !== "build_describe_operations" &&
    !operation.scopes.every((scope) => context.scopes?.includes(scope))
  )
    throw new TracerError(
      "UNAUTHORIZED",
      `Missing required permission: ${operation.scopes
        .filter((scope) => !context.scopes?.includes(scope))
        .join(", ")}.`,
      {
        status: 403,
        details: {
          reason: "INSUFFICIENT_SCOPE",
          missingScopes: operation.scopes.filter(
            (scope) => !context.scopes?.includes(scope)
          ),
        },
      }
    )
  try {
    // DB-only operations can commit their mutation and replay response as one
    // unit. Open-world operations deliberately use their domain-level event,
    // provider or lease idempotency instead of this generic receipt.
    if (
      operation.idempotency !== "none" &&
      idempotencyKey &&
      !operation.openWorld
    )
      return await executeAtomicBuildOperation(
        operation,
        context,
        value,
        idempotencyKey
      )
    return validateBuildResult(
      operation,
      name,
      await operation.execute(context, value)
    )
  } catch (error) {
    throw normalizeBuildError(error)
  }
}

/** The operation catalog itself is available over every Build transport. */
registerBuildOperation({
  name: "build_describe_operations",
  description:
    "Discover Build operation names, required scopes, JSON input schemas and retry/revision policies available to the authorized project.",
  scopes: ["build:read"],
  schema: z.object({
    name: z
      .string()
      .regex(/^build_[a-z][a-z0-9_]{1,119}$/)
      .optional(),
  }),
  execute: (context, input) => {
    const requested = typeof input.name === "string" ? input.name : undefined
    const catalog = buildOperationCatalog(
      context.scopes?.filter((scope) =>
        ["build:read", "build:write", "build:run"].includes(scope)
      ) ?? ["build:read"]
    )
    const selected = requested
      ? catalog.filter((operation) => operation.name === requested)
      : catalog
    if (!selected.length)
      throw new TracerError(
        "NOT_FOUND",
        `Build operation '${requested ?? ""}' was not found.`
      )
    return selected
  },
})
