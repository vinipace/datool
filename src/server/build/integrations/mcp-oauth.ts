import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { sql } from "drizzle-orm"
import { z } from "zod"
import {
  decryptProviderKey,
  encryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "../context"
import { assertPublicHttpUrl, publicHttpRequest } from "../http"
import { composioUserId } from "./provider"

export type McpConfig = {
  url: string
  token?: string
  authType?: "none" | "token" | "oauth"
  oauth?: {
    redirectUri: string
    clientMetadataUrl?: string
    client?: OAuthClientInformationMixed
    tokens?: OAuthTokens
    verifier?: string
    discovery?: OAuthDiscoveryState
    pendingAgentId?: string
  }
}

export const mcpOAuthCallbackPath = "/api/integrations/mcp/oauth/callback"
export const mcpOAuthMetadataPath = "/api/integrations/mcp/oauth/client"
export const mcpOAuthStateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex")
const unavailable = () =>
  new TracerError(
    "VALIDATION_ERROR",
    "Unable to authorize this MCP server. Check that it supports OAuth, or choose Access token. If it requires a registered app, enter its client ID in OAuth settings."
  )

function appOrigin() {
  const url = new URL(process.env.BETTER_AUTH_URL ?? "")
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw unavailable()
  return url.origin
}

export function mcpOAuthClientMetadata() {
  const origin = appOrigin()
  return {
    client_id: origin + mcpOAuthMetadataPath,
    client_name: "Datool",
    redirect_uris: [origin + mcpOAuthCallbackPath],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }
}

/** OAuth discovery and token requests use the same DNS-pinned boundary as tools. */
export const mcpOAuthFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = assertPublicHttpUrl(request.url)
  if (url.protocol !== "https:") throw unavailable()
  const result = await publicHttpRequest(url.href, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body ? await request.text() : undefined,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), request.signal]),
    maxResponseBytes: 2 * 1024 * 1024,
  })
  if (result.status >= 300 && result.status < 400) throw unavailable()
  return new Response(result.body.length ? new Uint8Array(result.body) : null, {
    status: result.status,
    headers: result.headers,
  })
}

export function mcpOAuthProvider(
  config: McpConfig,
  options: {
    persist?: () => Promise<void>
    state?: string
    redirect?: (url: URL) => void
  } = {}
): OAuthClientProvider {
  const oauth = config.oauth
  if (!oauth) throw unavailable()
  const save = async () => {
    await options.persist?.()
  }
  return {
    redirectUrl: oauth.redirectUri,
    clientMetadataUrl: oauth.clientMetadataUrl,
    clientMetadata: {
      client_name: "Datool",
      redirect_uris: [oauth.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: oauth.client?.client_secret
        ? "client_secret_post"
        : "none",
    },
    state: () => {
      if (!options.state)
        throw new Error("Reconnect this MCP server in Integrations.")
      return options.state
    },
    clientInformation: () => oauth.client,
    saveClientInformation: async (value) => {
      oauth.client = value
      await save()
    },
    tokens: () => oauth.tokens,
    saveTokens: async (value) => {
      oauth.tokens = value
      await save()
    },
    saveCodeVerifier: async (value) => {
      oauth.verifier = value
      await save()
    },
    codeVerifier: () => {
      if (!oauth.verifier) throw unavailable()
      return oauth.verifier
    },
    redirectToAuthorization: (url) => {
      if (!options.redirect)
        throw new Error("Reconnect this MCP server in Integrations.")
      const checked = assertPublicHttpUrl(url.href)
      if (checked.protocol !== "https:") throw unavailable()
      options.redirect(checked)
    },
    discoveryState: () => oauth.discovery,
    saveDiscoveryState: async (value) => {
      oauth.discovery = value
      await save()
    },
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "client") delete oauth.client
      if (scope === "all" || scope === "tokens") delete oauth.tokens
      if (scope === "all" || scope === "verifier") delete oauth.verifier
      if (scope === "all" || scope === "discovery") delete oauth.discovery
      await save()
    },
  }
}

export const startMcpOAuthSchema = z.object({
  connectionId: z.string().uuid().optional(),
  agentId: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(4096).optional(),
  clientId: z.string().trim().min(1).max(2000).optional(),
  clientSecret: z.string().trim().max(4000).optional(),
  returnTo: z
    .string()
    .max(4096)
    .refine(
      (value) =>
        value.startsWith("/p/") &&
        !value.includes("\\") &&
        !/[\r\n]/.test(value)
    ),
})

export async function startMcpOAuth(
  context: BuildContext,
  input: z.infer<typeof startMcpOAuthSchema>
) {
  const ctx = await assertBuildProject(context)
  const parsed = startMcpOAuthSchema.parse(input)
  if (parsed.agentId)
    await (await import("../agents")).getAgent(ctx, parsed.agentId)
  if (
    !ctx.actorId ||
    !(
      await ctx.database.execute(
        sql`SELECT id FROM "user" WHERE id=${ctx.actorId}`
      )
    ).rows.length
  )
    throw new TracerError(
      "UNAUTHORIZED",
      "Sign in to connect an MCP account with OAuth."
    )
  const id = parsed.connectionId ?? randomUUID()
  const previous = parsed.connectionId
    ? (
        await ctx.database.execute<{ mcp_config_encrypted: string | null }>(
          sql`SELECT mcp_config_encrypted FROM build_app_connections WHERE id=${id}::uuid AND project_id=${ctx.projectId} AND toolkit='custom_mcp'`
        )
      ).rows[0]
    : undefined
  if (parsed.connectionId && !previous)
    throw new TracerError("NOT_FOUND", "MCP connection not found.")
  const priorConfig: McpConfig | undefined = previous?.mcp_config_encrypted
    ? JSON.parse(
        decryptProviderKey(
          previous.mcp_config_encrypted,
          ctx.projectId,
          `build-mcp:${id}`
        )
      )
    : undefined
  const url = assertPublicHttpUrl(parsed.url ?? priorConfig?.url ?? "")
  if (url.protocol !== "https:" || url.hash) throw unavailable()
  const origin = appOrigin()
  const config: McpConfig = {
    url: url.href,
    authType: "oauth",
    oauth: {
      ...(parsed.agentId ? { pendingAgentId: parsed.agentId } : {}),
      redirectUri: origin + mcpOAuthCallbackPath,
      ...(origin.startsWith("https:")
        ? { clientMetadataUrl: origin + mcpOAuthMetadataPath }
        : {}),
      ...(parsed.clientId
        ? {
            client: {
              client_id: parsed.clientId,
              ...(parsed.clientSecret
                ? { client_secret: parsed.clientSecret }
                : {}),
            },
          }
        : {}),
    },
  }
  const state = randomBytes(32).toString("base64url")
  let redirectUrl: string | undefined
  try {
    const { beginCustomMcpOAuth } = await import("./custom-mcp")
    redirectUrl = await beginCustomMcpOAuth(config, state)
  } catch {
    throw unavailable()
  }
  if (!redirectUrl || !config.oauth?.verifier) throw unavailable()
  const encrypted = encryptProviderKey(
    JSON.stringify(config),
    ctx.projectId,
    `build-mcp:${id}`
  )
  url.search = ""
  // One statement commits the pending account and its one-use, user-bound state.
  const result = await ctx.database.execute(sql`
    WITH connection AS (
      INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status,mcp_url,mcp_has_token,mcp_auth_type,mcp_config_encrypted)
      VALUES(${id}::uuid,${ctx.projectId},${ctx.idempotencyKey ?? id},'custom_mcp',${parsed.name},${composioUserId(ctx.organizationId, ctx.projectId)},'custom-mcp-v1','pending',${url.href},false,'oauth',${encrypted})
      ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,status='pending',mcp_url=EXCLUDED.mcp_url,mcp_has_token=false,mcp_auth_type='oauth',mcp_config_encrypted=EXCLUDED.mcp_config_encrypted,updated_at=now()
      WHERE build_app_connections.project_id=${ctx.projectId} AND build_app_connections.mcp_config_encrypted IS NOT DISTINCT FROM ${previous?.mcp_config_encrypted ?? null}
      RETURNING id
    )
    INSERT INTO build_mcp_oauth_requests(connection_id,project_id,actor_id,state_hash,return_to)
    SELECT id,${ctx.projectId},${ctx.actorId},${mcpOAuthStateHash(state)},${parsed.returnTo} FROM connection
    ON CONFLICT(connection_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,state_hash=EXCLUDED.state_hash,return_to=EXCLUDED.return_to,expires_at=now()+interval '10 minutes',claimed_at=NULL
    RETURNING connection_id
  `)
  if (!result.rows.length)
    throw new TracerError(
      "CONFLICT",
      "The connection changed. Refresh Integrations and try again."
    )
  return { id, redirectUrl }
}

export async function completeMcpOAuth(
  context: BuildContext,
  input: { state: string; code?: string; denied?: boolean }
) {
  const ctx = await assertBuildProject(context)
  if (!/^[\w-]{43}$/.test(input.state) || !ctx.actorId) throw unavailable()
  const claimed = await ctx.database.execute<{
    connection_id: string
    return_to: string
    mcp_config_encrypted: string
  }>(sql`
    UPDATE build_mcp_oauth_requests r SET claimed_at=now() FROM build_app_connections c
    WHERE r.connection_id=c.id AND r.project_id=${ctx.projectId} AND r.actor_id=${ctx.actorId}
      AND r.state_hash=${mcpOAuthStateHash(input.state)} AND r.expires_at>now() AND r.claimed_at IS NULL
      AND c.project_id=r.project_id AND c.status='pending' AND c.mcp_auth_type='oauth'
    RETURNING r.connection_id,r.return_to,c.mcp_config_encrypted
  `)
  const row = claimed.rows[0]
  if (!row) throw unavailable()
  let encrypted = row.mcp_config_encrypted
  try {
    if (input.denied || !input.code || input.code.length > 4096)
      throw unavailable()
    const config: McpConfig = JSON.parse(
      decryptProviderKey(
        encrypted,
        ctx.projectId,
        `build-mcp:${row.connection_id}`
      )
    )
    const agentId = config.oauth?.pendingAgentId
    const result = await auth(mcpOAuthProvider(config), {
      serverUrl: config.url,
      authorizationCode: input.code,
      fetchFn: mcpOAuthFetch,
    })
    if (result !== "AUTHORIZED" || !config.oauth?.tokens?.access_token)
      throw unavailable()
    delete config.oauth.verifier
    delete config.oauth.pendingAgentId
    const next = encryptProviderKey(
      JSON.stringify(config),
      ctx.projectId,
      `build-mcp:${row.connection_id}`
    )
    const saved = await ctx.database.execute(
      sql`UPDATE build_app_connections SET mcp_config_encrypted=${next},mcp_has_token=true,updated_at=now() WHERE id=${row.connection_id}::uuid AND project_id=${ctx.projectId} AND status='pending' AND mcp_config_encrypted=${encrypted} RETURNING id`
    )
    if (!saved.rows.length) throw unavailable()
    encrypted = next
    const { checkCustomMcpConnection } = await import("./custom-mcp")
    encrypted = (await checkCustomMcpConnection(
      {
        id: row.connection_id,
        project_id: ctx.projectId,
        status: "pending",
        mcp_config_encrypted: encrypted,
      },
      ctx.database
    ))!
    const activated = await ctx.database.execute(
      sql`UPDATE build_app_connections SET status='active',updated_at=now() WHERE id=${row.connection_id}::uuid AND project_id=${ctx.projectId} AND status='pending' AND mcp_config_encrypted=${encrypted} RETURNING id`
    )
    if (!activated.rows.length) throw unavailable()
    if (agentId) {
      try {
        await (
          await import("./mcp-agent-tools")
        ).enableMcpTools(ctx, agentId, row.connection_id)
      } catch {
        return { returnTo: row.return_to, success: true, toolsReady: false }
      }
    }
    return { returnTo: row.return_to, success: true }
  } catch {
    await ctx.database.execute(
      sql`UPDATE build_app_connections c SET status='failed',mcp_config_encrypted=NULL,mcp_has_token=false,updated_at=now() FROM build_mcp_oauth_requests r WHERE c.id=${row.connection_id}::uuid AND c.project_id=${ctx.projectId} AND c.status='pending' AND r.connection_id=c.id AND r.state_hash=${mcpOAuthStateHash(input.state)}`
    )
    return { returnTo: row.return_to, success: false }
  } finally {
    await ctx.database.execute(
      sql`DELETE FROM build_mcp_oauth_requests WHERE connection_id=${row.connection_id}::uuid AND state_hash=${mcpOAuthStateHash(input.state)}`
    )
  }
}
