import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { assertBillingAccess } from "@/src/server/billing/store"
import { TracerError } from "@/src/server/tracer/errors"
import { roleScopes, mcpScopes, workspaceScopes } from "@/src/lib/auth/permissions"
export { mcpScopes } from "@/src/lib/auth/permissions"
export type McpConfig = {
  resource: string
  issuer: string
  jwksUrl: string
  origins: string[]
  scopes?: readonly string[]
}
export function cliConfig(env = process.env): McpConfig {
  const config = mcpConfig(env)
  return { ...config, resource: new URL("/api/cli", config.resource).href, scopes: workspaceScopes }
}
export type McpIdentity = {
  kind?: "oauth" | "api-key"
  apiKeyId?: string
  apiKeyName?: string
  clientId?: string
  subject: string
  organizationId: string
  projectId: string
  scopes: string[]
}
export class McpAuthError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
export function mcpConfig(env = process.env): McpConfig {
  let url: URL
  try {
    url = new URL(env.BETTER_AUTH_URL ?? "")
  } catch {
    throw new McpAuthError("BETTER_AUTH_URL is required for MCP OAuth.", 503)
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/"
  )
    throw new McpAuthError(
      "BETTER_AUTH_URL must be an HTTPS origin (HTTP is allowed on loopback).",
      503
    )
  const base = url.origin
  return {
    resource: `${base}/api/mcp`,
    issuer: `${base}/api/auth`,
    jwksUrl: `${base}/api/auth/jwks`,
    origins: (env.DATOOL_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  }
}
export function resourceMetadata(config: McpConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...mcpScopes],
    bearer_methods_supported: ["header"],
    resource_name: "Datool MCP",
  }
}
/** Signature validation never trusts Google ID tokens, caller project headers, or an env user allowlist. */
export async function verifyMcpToken(
  token: string,
  config: McpConfig,
  key: JWTVerifyGetKey
) {
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    issuer: config.issuer,
    audience: config.resource,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "client_id"],
    clockTolerance: 5,
  })
  if (
    protectedHeader.typ !== "at+jwt" ||
    typeof payload.projectId !== "string" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.client_id !== "string"
  )
    throw new McpAuthError(
      "A project-bound Datool access token is required.",
      401
    )
  if (payload.cnf)
    throw new McpAuthError(
      "Sender-constrained tokens require a supported proof mechanism.",
      401
    )
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope
          .split(/\s+/)
          .filter((scope) => ((config.scopes ?? mcpScopes) as readonly string[]).includes(scope))
      : []
  if (!scopes.length)
    throw new McpAuthError("A Datool resource scope is required.", 403)
  return { payload, scopes }
}
export async function authenticate(
  request: Request,
  config: McpConfig
): Promise<McpIdentity> {
  const identity = await authenticateIdentity(request, config)
  try { await assertBillingAccess(identity.organizationId) }
  catch (error) {
    if (error instanceof TracerError) throw new McpAuthError(error.message, error.status)
    throw error
  }
  return identity
}

async function authenticateIdentity(request: Request, config: McpConfig): Promise<McpIdentity> {
  const authorization = request.headers.get("authorization")
  if (!authorization || !/^Bearer \S+$/i.test(authorization))
    throw new McpAuthError("Bearer access token required.", 401)
  if (authorization.startsWith("Bearer dtk_")) {
    const { authorizeOrganizationKey } = await import("@/src/server/auth/request")
    const projectId = request.headers.get("x-project-id")
    if (!projectId) throw new McpAuthError("x-project-id is required for API keys.", 400)
    try {
      const key = await authorizeOrganizationKey(request, projectId, [])
      if (!key) throw new McpAuthError("Invalid API key.", 401)
      return { ...key, projectId, subject: key.apiKeyId, kind: "api-key" }
    } catch (error) {
      if (error instanceof McpAuthError) throw error
      const { TracerError } = await import("@/src/server/tracer/errors")
      if (error instanceof TracerError) throw new McpAuthError(error.message, error.status)
      throw error
    }
  }
  try {
    const { payload, scopes } = await verifyMcpToken(
      authorization.slice(7),
      config,
      createLocalJWKSet(await getAuth().api.getJwks())
    )
    const access = await db.query<{ role: string }>(
      `
      SELECT m.role FROM project p JOIN member m ON m."organizationId" = p.organization_id AND m."userId" = $2
      WHERE p.id = $1 AND p.organization_id = $3`,
      [payload.projectId, payload.sub, payload.organizationId]
    )
    if (!access.rows[0])
      throw new McpAuthError("Project membership is no longer active.", 403)
    // Consent revocation and client disablement take effect on the next MCP request.
    const consent = await db.query<{ scopes: string[] }>(
      `
      SELECT c.scopes FROM "oauthConsent" c JOIN "oauthClient" client ON client."clientId" = c."clientId"
      WHERE c."clientId" = $1 AND c."userId" = $2 AND c."referenceId" = $3 AND client.disabled = false`,
      [payload.client_id, payload.sub, payload.projectId]
    )
    const granted = consent.rows.flatMap((row) =>
      Array.isArray(row.scopes) ? row.scopes : []
    )
    const effectiveScopes = scopes.filter(
      (scope) =>
        (roleScopes(access.rows[0].role) as readonly string[]).includes(
          scope
        ) && granted.includes(scope)
    )
    if (!effectiveScopes.length)
      throw new McpAuthError(
        "OAuth consent or permissions have been revoked.",
        403
      )
    if (typeof payload.sid === "string") {
      const session = await db.query(
        'SELECT id FROM session WHERE id = $1 AND "userId" = $2 AND "expiresAt" > NOW()',
        [payload.sid, payload.sub]
      )
      if (!session.rows.length)
        throw new McpAuthError("OAuth session has ended.", 401)
    }
    return {
      subject: payload.sub!,
      kind: "oauth",
      clientId: payload.client_id as string,
      projectId: payload.projectId as string,
      organizationId: payload.organizationId as string,
      scopes: effectiveScopes,
    }
  } catch (error) {
    if (error instanceof McpAuthError) throw error
    throw new McpAuthError("Invalid or expired access token.", 401)
  }
}
export function checkOrigin(request: Request, config: McpConfig) {
  const origin = request.headers.get("origin")
  if (
    origin &&
    origin !== new URL(config.resource).origin &&
    !config.origins.includes(origin)
  )
    throw new McpAuthError("Origin is not allowed.", 403)
}
export function authFailure(error: unknown, config?: McpConfig) {
  const status = error instanceof McpAuthError ? error.status : 500
  const headers = new Headers({ "Cache-Control": "no-store" })
  if (config && (status === 401 || status === 403))
    headers.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/api/mcp", config.resource).href}", error="${status === 401 ? "invalid_token" : "insufficient_scope"}"`
    )
  return Response.json(
    {
      error:
        error instanceof McpAuthError ? error.message : "MCP request failed.",
    },
    { status, headers }
  )
}
