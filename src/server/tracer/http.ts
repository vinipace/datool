import { NextResponse } from "next/server"
import { traceReadCache, traceReadCacheMode } from "./trace-read-cache"
import { sharedReadCache } from "./shared-read-cache"
import { apiErrorHint } from "@/lib/api-error-hint"
import { assertBillingAccess } from "@/src/server/billing/store"
import { authorizeOrganizationKey, requireScopes, routeScopes } from "@/src/server/auth/request"
import { authenticate, cliConfig, McpAuthError } from "@/src/server/mcp/auth"
import { withWorkspace, type WorkspaceIdentity } from "@/src/server/auth/context"
import { roleScopes } from "@/src/lib/auth/permissions"
import { createHash, timingSafeEqual } from "node:crypto"

import { hasTrustedMutationOrigin, readJson as readBoundedJson } from "@/lib/api-response"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/project-access"
import type { ApiEnvelope, JsonObject } from "@/src/lib/tracer/contracts"
import { runWithTracerService, type TracerEffect } from "@/src/server/tracer/effect"
import { asTracerError, TracerError, validation } from "@/src/server/tracer/errors"
import { getTracerService, type TracerService } from "@/src/server/tracer/service"

export type TracerApiContext = {
  identity: WorkspaceIdentity
  projectId: string
  /** Forwarded only for the in-process demo SDK, never persisted by the service. */
  sdkHeaders: Record<string, string>
}

const MAX_TRACER_REQUEST_BYTES = 1024 * 1024

/** Public origin used only in API responses and compatibility callers. */
export function localDemoOrigin() {
  const baseUrl = process.env.BETTER_AUTH_URL
  if (!baseUrl) {
    throw new TracerError("INTERNAL_ERROR", "BETTER_AUTH_URL is required before running the demo.", { status: 503 })
  }
  try {
    return new URL(baseUrl).origin
  } catch {
    throw new TracerError("INTERNAL_ERROR", "BETTER_AUTH_URL must be a valid absolute URL.", { status: 503 })
  }
}

/** Resolves the explicit project scope required by every tracer request. */
export function getTracerRequestProjectId(request: Request) {
  const urlProjectId = new URL(request.url).searchParams.get("projectId")
  const headerProjectId = request.headers.get("x-project-id")
  if (urlProjectId && headerProjectId && urlProjectId !== headerProjectId) {
    throw validation("projectId query parameter and x-project-id header must match.")
  }
  const projectId = headerProjectId ?? urlProjectId
  if (!projectId || projectId.trim().length === 0 || projectId.length > 200) {
    throw validation("A project ID is required in x-project-id or projectId.")
  }
  return projectId
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  const token = authorization.slice("Bearer ".length).trim()
  return token || null
}

function tokensMatch(left: string, right: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest()
  return timingSafeEqual(hash(left), hash(right))
}

/**
 * Verifies the configured SDK key and its single project binding. Existence of
 * that project is checked by authorizeApiKey before a service is constructed.
 */
export function validateTracerApiKeyBinding(request: Request, projectId: string) {
  const token = bearerToken(request)
  if (!token) return false
  const configuredKey = process.env.DATOOL_API_KEY?.trim()
  const configuredProjectId = process.env.DATOOL_PROJECT_ID?.trim()
  if (!configuredKey || !configuredProjectId) {
    throw new TracerError(
      "INTERNAL_ERROR",
      "DATOOL_API_KEY requires DATOOL_PROJECT_ID before SDK ingestion is enabled.",
      { status: 503 },
    )
  }
  if (!tokensMatch(token, configuredKey)) {
    throw new TracerError("UNAUTHORIZED", "Missing or invalid DATOOL_API_KEY.")
  }
  if (projectId !== configuredProjectId) {
    throw new TracerError("UNAUTHORIZED", "DATOOL_API_KEY is not authorized for this project.", { status: 403 })
  }
  return true
}

/** An SDK key has one explicit project binding; it cannot authorize arbitrary projects. */
async function authorizeApiKey(request: Request, projectId: string) {
  if (!validateTracerApiKeyBinding(request, projectId)) return false
  const project = await db.query<{ id: string }>("SELECT id FROM project WHERE id = $1 LIMIT 1", [projectId])
  if (!project.rows[0]) {
    throw new TracerError("NOT_FOUND", "DATOOL_PROJECT_ID does not identify an existing project.")
  }
  return true
}

export async function authorizeProject(request: Request): Promise<TracerApiContext> {
  const context = await authenticateProject(request)
  await assertBillingAccess(context.identity.organizationId)
  return context
}

async function authenticateProject(request: Request): Promise<TracerApiContext> {
  const projectId = getTracerRequestProjectId(request)
  const scopes = await routeScopes(request)
  // CLI tokens have their own audience. MCP, ID and foreign tokens cannot authorize REST.
  if (bearerToken(request)?.split(".").length === 3) {
    try {
      const identity = await authenticate(request, cliConfig())
      if (identity.projectId !== projectId) throw new TracerError("UNAUTHORIZED", "OAuth login is bound to a different project.", { status: 403 })
      requireScopes(identity.scopes, scopes)
      return { projectId, identity: { ...identity, userId: identity.subject, kind: "oauth" }, sdkHeaders: { "x-project-id": projectId } }
    } catch (error) {
      if (error instanceof McpAuthError) throw new TracerError("UNAUTHORIZED", error.message, { status: error.status })
      throw error
    }
  }
  const organizationKey = await authorizeOrganizationKey(request, projectId, scopes)
  if (organizationKey) return { projectId, identity: { ...organizationKey, projectId, kind: "api-key" }, sdkHeaders: { "x-project-id": projectId } }
  if (await authorizeApiKey(request, projectId)) {
    if (scopes.some(scope => scope !== "traces:write")) throw new TracerError("UNAUTHORIZED", "Legacy ingestion keys only permit traces:write. Create an organization API key for additional permissions.", { status: 403 })
    const project = await db.query<{ organizationId: string }>('SELECT organization_id AS "organizationId" FROM project WHERE id = $1', [projectId])
    return { projectId, identity: { organizationId: project.rows[0].organizationId, projectId, scopes: ["traces:write"], kind: "api-key" }, sdkHeaders: { "x-project-id": projectId } }
  }

  const access = await requireProjectAccess(request, projectId)
  if (access.kind === "payment-required") throw new TracerError("UNAUTHORIZED", "An active Cloud subscription is required. Open /billing.", { status: 402 })
  if (access.kind === "unauthenticated") {
    throw new TracerError("UNAUTHORIZED", "Authentication is required.")
  }
  if (access.kind === "forbidden") {
    throw new TracerError("UNAUTHORIZED", "You do not have access to this project.", { status: 403 })
  }
  if (access.kind === "not-found") {
    throw new TracerError("NOT_FOUND", "Project was not found.")
  }

  const allowed = roleScopes(access.access.role)
  if (scopes.some(scope => !allowed.includes(scope))) throw new TracerError("UNAUTHORIZED", "Your role does not grant the required permissions.", { status: 403 })
  const cookie = request.headers.get("cookie")
  return {
    projectId,
    identity: { organizationId: access.access.project.organizationId, projectId, userId: access.access.userId, kind: "session", scopes: allowed },
    sdkHeaders: {
      ...(cookie ? { cookie } : {}),
      origin: new URL(request.url).origin,
      "x-project-id": projectId,
    },
  }
}

/** Browser mutations must originate from the configured Better Auth URL. */
export function assertTracerMutationOrigin(request: Request) {
  if (!bearerToken(request) && !hasTrustedMutationOrigin(request)) {
    throw new TracerError("UNAUTHORIZED", "Request origin is not trusted.", { status: 403 })
  }
}

export async function readJson(request: Request, maxBytes = MAX_TRACER_REQUEST_BYTES): Promise<unknown> {
  const body = await readBoundedJson(request, maxBytes)
  if (body.kind === "too-large") {
    throw new TracerError("VALIDATION_ERROR", `Request body exceeds the ${maxBytes / (1024 * 1024)} MiB limit.`, { status: 413, details: { maxBytes } })
  }
  if (body.kind === "invalid") throw validation("Request body must be valid JSON.")
  return body.value
}

export function apiError(error: unknown) {
  const normalized = asTracerError(error)
  const body: { error: { code: string; details?: JsonObject; message: string; hint: string } } = {
    error: {
      code: normalized.code,
      message: normalized.message,
      hint: apiErrorHint(normalized.status),
    },
  }
  if (normalized.details) body.error.details = normalized.details
  return NextResponse.json(body, {
    status: normalized.status,
    headers: {
      "Cache-Control": "no-store",
      ...(normalized.status === 429
        ? { "Retry-After": String(normalized.details?.retryAfterSeconds ?? 60) }
        : {}),
    },
  })
}

export async function api<T>(
  request: Request,
  action: (service: TracerService, context: TracerApiContext) => TracerEffect<T> | Promise<TracerEffect<T>>,
  options?: { mutation?: boolean; readCache?: "trace-versioned" | "trace-shared" | "shared" },
) {
  try {
    const context = await authorizeProject(request)
    if (options?.mutation) assertTracerMutationOrigin(request)
    return await withWorkspace(context.identity, async () => {
      const service = await getTracerService(context.projectId)
      const load = async () => {
        const program = await action(service, context)
        return runWithTracerService(service, () => program)
      }
      if (options?.readCache && request.method === "GET") {
        const url = new URL(request.url)
        url.searchParams.sort()
        const input = {
          projectId: context.projectId,
          key: `${url.pathname}?${url.searchParams}`,
          etag: request.headers.get("if-none-match"),
          force: request.headers.get("x-datool-refresh") === "force",
          load,
        }
        const result = options.readCache === "shared"
          ? await sharedReadCache()({ ...input, enabled: process.env.DATOOL_COLLECTION_READ_CACHE !== "off" })
          : await traceReadCache()({ ...input, versioned: options.readCache === "trace-versioned", mode: traceReadCacheMode() })
        const headers = {
          "Cache-Control": "no-store", "X-Datool-Cache": result.state,
          ...(result.etag ? { ETag: result.etag } : {}),
        }
        if (result.unchanged) return new NextResponse(null, { status: 304, headers })
        return NextResponse.json({ data: result.data } satisfies ApiEnvelope<T>, { headers })
      }
      const data = await load()
      return NextResponse.json({ data } satisfies ApiEnvelope<T>, { headers: { "Cache-Control": "no-store" } })
    })
  } catch (error) {
    return apiError(error)
  }
}

/** Apply project authorization to auxiliary app handlers too. */
export function workspaceRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args) => {
    try {
      const context = await authorizeProject(request)
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) assertTracerMutationOrigin(request)
      return await withWorkspace(context.identity, () => handler(request, ...args))
    } catch (error) { return apiError(error) }
  }
}

/** Compatibility name for already-authorized auxiliary handlers. */
export const assertLocalMutation = assertTracerMutationOrigin
