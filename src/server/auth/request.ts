import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { hasTrustedMutationOrigin } from "@/lib/api-response"
import { TracerError } from "@/src/server/tracer/errors"
import { findAgentOperation } from "@/src/server/mcp/operations"
import {
  type WorkspaceScope,
} from "@/src/lib/auth/permissions"

export function requireScopes(granted: readonly string[], required: readonly WorkspaceScope[]) {
  const missingScopes = required.filter(scope => !granted.includes(scope))
  if (missingScopes.length) throw new TracerError("UNAUTHORIZED", `Missing required permission: ${missingScopes.join(", ")}.`, {
    status: 403, details: { reason: "INSUFFICIENT_SCOPE", missingScopes },
  })
}

export function assertSameOrigin(request: Request) {
  if (!hasTrustedMutationOrigin(request))
    throw new TracerError(
      "UNAUTHORIZED",
      "A same-origin browser request is required.",
      { status: 403 }
    )
}
/** Permission classification is explicit so a new route fails closed. */
export async function routeScopes(request: Request): Promise<WorkspaceScope[]> {
  const url = new URL(request.url)
  const resource = url.pathname.split("/")[2]
  if (url.pathname === "/api/cli/session" && request.method === "GET") return []
  if (resource === "agent") {
    const operation = findAgentOperation(url.pathname.split("/")[3])
    if (!operation || request.method !== "POST")
      throw new TracerError("UNAUTHORIZED", "Unknown agent operation or method.", { status: 403 })
    return [...operation.scopes]
  }
  const domains: Record<string, string> = {
    ingest: "traces",
    traces: "traces",
    spans: "traces",
    sessions: "traces",
    reviews: "reviews",
    "human-scores": "reviews",
    "human-score-collections": "reviews",
    metrics: "metrics",
    datasets: "datasets",
    "dataset-items": "datasets",
    scorers: "scorers",
    prompts: "prompts",
    evaluators: "scorers",
    views: "views",
    "custom-views": "views",
    "react-views": "views",
    "custom-fields": "views",
    dashboards: "dashboards",
    evals: "evals",
    "imported-scores": "evals",
    apps: "apps",
    playgrounds: "playgrounds",
    demo: "traces",
  }
  if (resource === "ingest") return ["traces:write"]
  if (resource === "resources") {
    if (request.method === "GET")
      return [
        url.searchParams.get("kind") === "dataset"
          ? "datasets:read"
          : "scorers:read",
      ]
    // Resource imports can include datasets and scorers; require both permissions.
    return ["datasets:write", "scorers:write"]
  }
  if (resource === "reviews" && request.method === "POST") return ["reviews:write", "traces:read"]
  if (resource === "reviews" && request.method === "GET" && /^\/api\/reviews\/[^/]+\/table\/?$/.test(url.pathname)) return ["reviews:read", "traces:read"]
  if (resource === "reviews" && request.method === "PUT") return ["reviews:write"]
  const domain = domains[resource]
  if (!domain)
    throw new TracerError("UNAUTHORIZED", "Unregistered API resource.", {
      status: 403,
    })
  return [
    `${domain}:${request.method === "GET" || domain === "metrics" ? "read" : "write"}` as WorkspaceScope,
  ]
}
export async function authorizeOrganizationKey(
  request: Request,
  projectId: string,
  requiredScopes: readonly WorkspaceScope[]
) {
  const match = /^Bearer (dtk_\S+)$/.exec(
    request.headers.get("authorization") ?? ""
  )
  if (!match) return null
  const verify = () => getAuth().api.verifyApiKey({ body: { key: match[1] } })
  let verified = await verify()
  // Better Auth also returns INVALID_API_KEY when its database lookup fails.
  // Check availability before treating that ambiguous result as a permanent
  // credential rejection. Retry once if the database recovered in between.
  for (let attempt = 0; !verified.valid && verified.error?.code === "INVALID_API_KEY"; attempt++) {
    try {
      await db.query("SELECT 1")
    } catch (cause) {
      throw new TracerError("INTERNAL_ERROR", "API key verification is temporarily unavailable. Retry this request.", { status: 503, cause })
    }
    if (attempt === 1) break
    verified = await verify()
  }
  if (!verified.valid && verified.error?.code === "RATE_LIMITED") {
    const details = (verified.error as { details?: { tryAgainIn?: number } }).details
    const retryAfterSeconds = Math.max(1, Math.ceil((details?.tryAgainIn ?? 60_000) / 1000))
    throw new TracerError("UNAUTHORIZED", "API key rate limit exceeded. Retry after the indicated delay.", {
      status: 429, details: { retryAfterSeconds },
    })
  }
  if (!verified.valid || !verified.key)
    throw new TracerError(
      "UNAUTHORIZED",
      "API key is invalid, expired, or revoked."
    )
  const project = await db.query<{ organizationId: string }>(
    `SELECT organization_id AS "organizationId" FROM project WHERE id = $1 AND organization_id = $2`,
    [projectId, verified.key.referenceId]
  )
  if (!project.rows[0])
    throw new TracerError(
      "UNAUTHORIZED",
      "API key is not authorized for this project.",
      { status: 403 }
    )
  const scopes = Object.entries(verified.key.permissions ?? {}).flatMap(
      ([resource, actions]) => actions.map((action) => `${resource}:${action}`)
    )
  requireScopes(scopes, requiredScopes)
  return { organizationId: project.rows[0].organizationId, scopes, apiKeyId: verified.key.id, apiKeyName: verified.key.name ?? "API key" }
}
