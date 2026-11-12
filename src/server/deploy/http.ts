import { db } from "@/lib/db"
import { projectMcpScopes } from "@/src/lib/auth/permissions"
import { withWorkspace } from "../auth/context"
import { requireScopes } from "../auth/scopes"
import { getBuildContext } from "../build/context"
import {
  authenticate,
  authFailure,
  checkOrigin,
  McpAuthError,
  projectMcpConfig,
  type McpConfig,
} from "../mcp/auth"
import { mcpOptions } from "../mcp/http"
import { audited, securityAudit } from "../security/audit"
import { TracerError } from "../tracer/errors"
import { getTracerRequestProjectId, readJson } from "../tracer/http"
import { parseEnvironment } from "./context"
import { projectMcp } from "./mcp"

async function target(request: Request, id?: string) {
  const url = new URL(request.url)
  if (!id) {
    return {
      projectId: getTracerRequestProjectId(request),
      environment: parseEnvironment(url.searchParams.get("environment")),
    }
  }
  // UUID project paths track Production. Compact UUIDs are immutable deployment IDs.
  let projectId: string
  let deploymentId: string | undefined
  if (/^[a-f0-9]{32}$/i.test(id)) {
    deploymentId = id.replace(
      /^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/,
      "$1-$2-$3-$4-$5"
    )
    const row = await db.query<{ project_id: string }>(
      "SELECT project_id FROM project_deployments WHERE id=$1::uuid",
      [deploymentId]
    )
    if (!row.rows[0]) throw new McpAuthError("Deployment not found.", 404)
    projectId = row.rows[0].project_id
  } else if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) {
    projectId = id.toLowerCase()
  } else {
    throw new McpAuthError("Invalid project or deployment URL.", 400)
  }
  for (const supplied of [
    request.headers.get("x-project-id"),
    url.searchParams.get("projectId"),
  ]) {
    if (supplied && supplied !== projectId)
      throw new McpAuthError("Project does not match the MCP URL.", 403)
  }
  if (url.searchParams.has("environment"))
    throw new McpAuthError(
      "Select the project or deployment URL without an environment parameter.",
      400
    )
  return { projectId, deploymentId, environment: "production" as const }
}

export async function handleProjectMcp(request: Request, id?: string) {
  let config: McpConfig | undefined
  let response: Response
  try {
    config = projectMcpConfig()
    checkOrigin(request, config)
    if (!/^Bearer \S+$/i.test(request.headers.get("authorization") ?? ""))
      throw new McpAuthError("Bearer access token required.", 401)
    const selection = await target(request, id)
    const headers = new Headers(request.headers)
    headers.set("x-project-id", selection.projectId)
    // Infer the API key's project from the URL; OAuth still checks its signed project claim.
    const identity = await authenticate(
      new Request(request.url, { headers }),
      config
    )
    if (identity.projectId !== selection.projectId)
      throw new McpAuthError("Access token belongs to another project.", 403)
    requireScopes(identity.scopes, projectMcpScopes)
    response = await withWorkspace(
      {
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        userId: identity.kind === "api-key" ? undefined : identity.subject,
        apiKeyId: identity.apiKeyId,
        apiKeyName: identity.apiKeyName,
        clientId: identity.clientId,
        scopes: identity.scopes,
        kind: identity.kind ?? "oauth",
      },
      () =>
        audited(
          { action: "project_mcp.request", targetId: selection.deploymentId },
          async () => {
            if (request.method !== "POST")
              return new Response(null, {
                status: 405,
                headers: { Allow: "POST, OPTIONS" },
              })
            return projectMcp(
              { ...getBuildContext(), environment: selection.environment },
              request,
              await readJson(request, 128 * 1024),
              selection.deploymentId
            )
          }
        )
    )
  } catch (error) {
    response = authFailure(
      error instanceof TracerError
        ? new McpAuthError(error.message, error.status)
        : error,
      config
    )
    securityAudit(
      {
        action: "project_mcp.request_failed",
        identity: { actorType: "unknown" },
      },
      response.status
    )
  }
  response.headers.set("Cache-Control", "no-store")
  const origin = request.headers.get("origin")
  if (
    config &&
    origin &&
    (origin === new URL(config.resource).origin ||
      config.origins.includes(origin))
  ) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set(
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, X-Datool-Trace-Id"
    )
    response.headers.set("Vary", "Origin")
  }
  return response
}

export const projectMcpOptions = (request: Request) =>
  mcpOptions(request, projectMcpConfig)
