import { sql } from "drizzle-orm"

import { workspaceIdentity } from "@/src/server/auth/context"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  createTracerDatabase,
  getTracerProjectId,
} from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"

/**
 * Every Build operation receives this context explicitly. The project id is
 * never inferred from process state or a request-global singleton, which keeps
 * customer-operation calls safe when MCP and channel workers run concurrently.
 */
export type BuildContext = {
  database: TracerDatabase
  projectId: string
  organizationId?: string
  actorId?: string
  /** Granted Build scopes for transport-bound calls; absent for worker fixtures. */
  scopes?: readonly string[]
  /** Request metadata used by durable turn/idempotency services. */
  requestKey?: string
  idempotencyKey?: string
}

export type BuildContextOptions = {
  projectId?: string
  organizationId?: string
  actorId?: string
  requestKey?: string
  idempotencyKey?: string
}

/** Creates an explicit context for workers, tests, and MCP handlers. */
export function createBuildContext(
  database: TracerDatabase,
  options: BuildContextOptions = {}
): BuildContext {
  const databaseProjectId = getTracerProjectId(database)
  if (options.projectId && options.projectId !== databaseProjectId) {
    throw new Error("Build context projectId must match its database scope.")
  }
  return {
    database,
    projectId: options.projectId ?? databaseProjectId,
    ...(options.organizationId
      ? { organizationId: options.organizationId }
      : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.requestKey ? { requestKey: options.requestKey } : {}),
    ...(options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  }
}

type BuildDatabaseRegistry = typeof globalThis & {
  __datoolBuildDatabases?: Map<string, TracerDatabase>
}

/**
 * Return the project-scoped database and identity for an authorized request.
 * The registry reuses the shared tracer pool while retaining the project
 * binding on every handle; no operation may infer a project from a global
 * environment variable or caller-provided body field.
 */
export function getBuildContext(options?: {
  requestKey?: string
  idempotencyKey?: string
}): BuildContext {
  const identity = workspaceIdentity()
  if (!identity?.projectId || !identity.organizationId) {
    throw new TracerError(
      "UNAUTHORIZED",
      "An authorized workspace is required for Build operations."
    )
  }
  const registry = globalThis as BuildDatabaseRegistry
  registry.__datoolBuildDatabases ??= new Map()
  let database = registry.__datoolBuildDatabases.get(identity.projectId)
  if (!database) {
    database = createTracerDatabase(undefined, {
      projectId: identity.projectId,
    })
    registry.__datoolBuildDatabases.set(identity.projectId, database)
  }
  return {
    database,
    projectId: identity.projectId,
    organizationId: identity.organizationId,
    actorId: identity.userId ?? identity.apiKeyId,
    scopes: identity.scopes,
    ...(options?.requestKey ? { requestKey: options.requestKey } : {}),
    ...(options?.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  }
}

export function assertBuildContext(context: BuildContext): BuildContext {
  if (
    !context ||
    typeof context.projectId !== "string" ||
    !context.projectId.trim()
  ) {
    throw new TracerError(
      "VALIDATION_ERROR",
      "A non-empty Build projectId is required."
    )
  }
  return context
}

/**
 * Proves that the requested project exists and, when supplied, belongs to the
 * caller's organization. All operation modules call this before reading or
 * writing customer data. Returns the verified organization for shared resources.
 */
export async function assertBuildProject(context: BuildContext) {
  const ctx = assertBuildContext(context)
  const result = await ctx.database.execute<{ organization_id: string }>(sql`
    select organization_id from project where id=${ctx.projectId}
  `)
  const row = result.rows[0]
  if (!row) {
    throw new TracerError(
      "NOT_FOUND",
      `Project '${ctx.projectId}' was not found.`
    )
  }
  if (ctx.organizationId && row.organization_id !== ctx.organizationId) {
    throw new TracerError(
      "UNAUTHORIZED",
      "The project is outside the active organization."
    )
  }
  return { ...ctx, organizationId: row.organization_id }
}

export function operationId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

export function asIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export function toPageCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
