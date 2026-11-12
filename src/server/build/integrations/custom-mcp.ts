import { createHash, randomUUID } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { sql } from "drizzle-orm"
import type {
  AppConnection,
  IntegrationTool,
} from "@/src/lib/build/integrations"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "../context"
import { assertPublicHttpUrl, publicHttpRequest } from "../http"
import { composioUserId } from "./provider"
import { mcpOAuthFetch, mcpOAuthProvider, type McpConfig } from "./mcp-oauth"
import { McpRuntimeError } from "./mcp-errors"
import { getTracerWritePool, type TracerDatabase } from "@/src/server/tracer/db"
import { agentMcpTraceHeaders } from "@/src/server/mcp/agent-trace"

export const CUSTOM_MCP_TOOLKIT = "custom_mcp"
export const saveMcpConnectionSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    agentId: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().url().max(4096).optional(),
    authType: z.enum(["none", "token", "oauth"]).optional(),
    token: z
      .string()
      .trim()
      .max(4000)
      .regex(/^[^\r\n]*$/)
      .optional(),
  })
  .refine((input) => input.connectionId || input.url, {
    message: "Enter the MCP server URL.",
    path: ["url"],
  })

export type CustomMcpRow = {
  id: string
  project_id: string
  status: AppConnection["status"]
  mcp_config_encrypted: string | null
}

function endpoint(raw: string) {
  const url = assertPublicHttpUrl(raw)
  if (url.protocol !== "https:")
    throw new Error("Use a public HTTPS MCP server URL.")
  if (url.hash) throw new Error("Remove the fragment from the MCP server URL.")
  return url
}

function configFor(row: CustomMcpRow): McpConfig {
  if (!row.mcp_config_encrypted)
    throw new Error("Reconnect this MCP server first.")
  return JSON.parse(
    decryptProviderKey(
      row.mcp_config_encrypted,
      row.project_id,
      `build-mcp:${row.id}`
    )
  )
}

const toolSlug = (name: string) =>
  `MCP_${createHash("sha256").update(name).digest("hex").toUpperCase()}`

async function withClient<T>(
  config: McpConfig,
  action: (client: Client) => Promise<T>,
  signal?: AbortSignal,
  persist?: () => Promise<void>,
  authorization?: { state: string; redirect: (url: URL) => void }
): Promise<T> {
  const url = endpoint(config.url)
  const client = new Client(
    { name: "datool", version: "1.0.0" },
    { capabilities: {} }
  )
  const deadline = AbortSignal.timeout(30_000)
  const transport = new StreamableHTTPClientTransport(url, {
    ...(config.authType === "oauth"
      ? {
          authProvider: mcpOAuthProvider(config, { persist, ...authorization }),
        }
      : {}),
    requestInit: {
      redirect: "error",
      headers:
        config.authType !== "oauth" && config.token
          ? { Authorization: `Bearer ${config.token}` }
          : {},
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      // Tools use bounded request/response sessions, without the optional notification stream.
      const requestUrl = new URL(
        input instanceof Request ? input.url : String(input)
      )
      if (requestUrl.href !== url.href && config.authType === "oauth")
        return mcpOAuthFetch(input, init)
      if (requestUrl.href !== url.href)
        throw new Error(
          "MCP redirects are not supported. Use the final server URL."
        )
      if (init?.method === "GET") return new Response(null, { status: 405 })
      const response = await publicHttpRequest(url.href, {
        method: init?.method ?? "POST",
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          ...agentMcpTraceHeaders(url, typeof init?.body === "string" ? init.body : undefined),
        },
        body: typeof init?.body === "string" ? init.body : undefined,
        maxResponseBytes: 2 * 1024 * 1024,
        timeoutMs: 30_000,
        signal: AbortSignal.any([
          deadline,
          ...(signal ? [signal] : []),
          ...(init?.signal ? [init.signal] : []),
        ]),
      })
      if (
        (response.status === 401 || response.status === 403) &&
        config.authType !== "oauth"
      )
        throw new McpRuntimeError(
          "MCP_AUTHORIZATION_REQUIRED",
          "The MCP server rejected this account. Reconnect it in Integrations or replace its access token.",
          {
            stage: "authorization",
            httpStatus: response.status,
            retryable: false,
          }
        )
      if (
        response.status >= 400 &&
        response.status !== 401 &&
        response.status !== 403
      )
        throw new McpRuntimeError(
          "MCP_HTTP_ERROR",
          `The MCP server returned HTTP ${response.status}. Check the server connection before retrying.`,
          {
            stage: "transport",
            httpStatus: response.status,
            retryable: response.status === 429 || response.status >= 500,
          }
        )
      return new Response(
        response.body.length ? new Uint8Array(response.body) : null,
        {
          status: response.status,
          headers: response.headers,
        }
      )
    },
  })
  try {
    await client.connect(transport, { timeout: 30_000, signal: deadline })
    return await action(client)
  } finally {
    await transport.terminateSession().catch(() => {})
    await client.close().catch(() => {})
  }
}

/** The real MCP handshake honors the server's WWW-Authenticate discovery URL and scopes. */
export async function beginCustomMcpOAuth(config: McpConfig, state: string) {
  let redirectUrl: string | undefined
  try {
    await withClient(config, toolsFor, undefined, undefined, {
      state,
      redirect: (url) => {
        redirectUrl = url.href
      },
    })
  } catch (error) {
    // The SDK interrupts connect after asking the browser to authorize.
    if (!redirectUrl) throw error
  }
  if (!redirectUrl)
    throw new Error(
      "This server did not request OAuth. Choose No authentication or Access token."
    )
  return redirectUrl
}

async function withSavedClient<T>(
  row: CustomMcpRow,
  database: TracerDatabase | undefined,
  action: (client: Client) => Promise<T>,
  signal?: AbortSignal
) {
  let config = configFor(row)
  const execute = () =>
    withClient(config, action, signal, async () => {
      if (!database)
        throw new McpRuntimeError(
          "MCP_CREDENTIAL_STORAGE_UNAVAILABLE",
          "MCP credential storage is unavailable for this execution. Refresh the runtime before retrying.",
          { stage: "credentials", connectionId: row.id, retryable: false }
        )
      const encrypted = encryptProviderKey(
        JSON.stringify(config),
        row.project_id,
        `build-mcp:${row.id}`
      )
      const saved = await database.execute(
        sql`UPDATE build_app_connections SET mcp_config_encrypted=${encrypted},mcp_has_token=${Boolean(config.oauth?.tokens?.access_token)},updated_at=now() WHERE id=${row.id}::uuid AND project_id=${row.project_id} AND status IN ('active','pending') AND mcp_config_encrypted=${row.mcp_config_encrypted} RETURNING id`
      )
      if (!saved.rows.length)
        throw new Error(
          "The MCP connection changed. Reconnect it in Integrations."
        )
      row.mcp_config_encrypted = encrypted
    })
  if (config.authType !== "oauth") return execute()
  if (!database)
    throw new McpRuntimeError(
      "MCP_CREDENTIAL_STORAGE_UNAVAILABLE",
      "MCP credential storage is unavailable for this execution. Refresh the runtime before retrying.",
      { stage: "credentials", connectionId: row.id, retryable: false }
    )
  // Serialize uses of a shared OAuth account across web/Eve workers. Rotating
  // refresh tokens must not be exchanged twice from the same saved credentials.
  // No SQL transaction or waiting pool connection spans another caller's work.
  const key = `datool-mcp:${row.project_id}:${row.id}`
  const deadline = Date.now() + 30_000
  do {
    signal?.throwIfAborted()
    const lock = await getTracerWritePool(database).connect()
    let held = false
    let destroy = false
    try {
      held = (
        await lock.query<{ held: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held",
          [key]
        )
      ).rows[0].held
      if (held) {
        const latest = (
          await database.execute<{ mcp_config_encrypted: string | null }>(
            sql`SELECT mcp_config_encrypted FROM build_app_connections WHERE id=${row.id}::uuid AND project_id=${row.project_id} AND status IN ('active','pending')`
          )
        ).rows[0]
        if (!latest?.mcp_config_encrypted)
          throw new Error("Reconnect this MCP server in Integrations.")
        row.mcp_config_encrypted = latest.mcp_config_encrypted
        config = configFor(row)
        return await execute()
      }
    } finally {
      if (held)
        await lock
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
          .catch(() => {
            destroy = true
          })
      lock.release(destroy)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error("This MCP account is busy. Try again shortly.")
}

async function toolsFor(client: Client) {
  const tools: IntegrationTool[] = []
  const names = new Map<string, string>()
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, {
      timeout: 15_000,
    })
    for (const tool of result.tools) {
      const slug = toolSlug(tool.name)
      if (names.has(slug)) continue
      names.set(slug, tool.name)
      tools.push({
        slug,
        name: tool.title || tool.name,
        originalName: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema,
      })
    }
    cursor = result.nextCursor
    if (!cursor) return { tools, names }
  }
  throw new Error("This MCP server returned too many pages of tools.")
}

export async function listCustomMcpTools(
  row: CustomMcpRow,
  database?: TracerDatabase
): Promise<IntegrationTool[]> {
  try {
    return await withSavedClient(
      row,
      database,
      async (client) => (await toolsFor(client)).tools
    )
  } catch (error) {
    if (error instanceof McpRuntimeError) throw error
    throw new McpRuntimeError(
      "MCP_DISCOVERY_FAILED",
      "Unable to load this MCP server's tool catalog. Check its URL or reconnect its account in Integrations.",
      { stage: "discovery", connectionId: row.id, retryable: true },
      error
    )
  }
}

export async function callCustomMcpTool(
  row: CustomMcpRow,
  slug: string,
  args: Record<string, unknown>,
  beforeCall: () => Promise<void>,
  signal?: AbortSignal,
  database?: TracerDatabase
) {
  return withSavedClient(
    row,
    database,
    async (client) => {
      const { names } = await toolsFor(client)
      const name = names.get(slug)
      if (!name) throw new Error("This MCP tool is no longer available.")
      await beforeCall()
      signal?.throwIfAborted()
      return client.callTool({ name, arguments: args }, undefined, {
        timeout: 30_000,
        signal,
      })
    },
    signal
  )
}

export async function saveMcpConnection(
  context: BuildContext,
  input: z.infer<typeof saveMcpConnectionSchema>
) {
  const ctx = await assertBuildProject(context)
  const parsed = saveMcpConnectionSchema.parse(input)
  if (parsed.agentId)
    await (await import("../agents")).getAgent(ctx, parsed.agentId)
  const id = parsed.connectionId ?? randomUUID()
  let previous: McpConfig | undefined
  let previousEncrypted: string | null = null
  if (parsed.connectionId) {
    const { rows } = await ctx.database.execute<CustomMcpRow>(sql`
      SELECT * FROM build_app_connections WHERE project_id=${ctx.projectId} AND id=${id}::uuid AND toolkit=${CUSTOM_MCP_TOOLKIT}
    `)
    if (!rows[0])
      throw new TracerError("NOT_FOUND", "MCP connection not found.")
    previousEncrypted = rows[0].mcp_config_encrypted
    if (previousEncrypted) previous = configFor(rows[0])
  }
  const authType =
    parsed.authType ??
    (parsed.token === ""
      ? "none"
      : parsed.token
        ? "token"
        : (previous?.authType ?? (previous?.token ? "token" : "none")))
  if (
    authType === "oauth" &&
    (!previous?.oauth?.tokens?.access_token ||
      (parsed.url && parsed.url !== previous.url))
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Connect this server with OAuth first."
    )
  const config: McpConfig = {
    url: parsed.url ?? previous?.url ?? "",
    authType,
    ...(authType === "oauth"
      ? { oauth: previous?.oauth }
      : authType === "token"
        ? { token: parsed.token ?? previous?.token }
        : {}),
  }
  let publicUrl: URL
  let encrypted: string
  try {
    publicUrl = endpoint(config.url)
    encrypted = encryptProviderKey(
      JSON.stringify(config),
      ctx.projectId,
      `build-mcp:${id}`
    )
    const row = {
      id,
      project_id: ctx.projectId,
      status: "active" as const,
      mcp_config_encrypted: previousEncrypted,
    }
    if (authType === "oauth") {
      await withSavedClient(row, ctx.database, toolsFor)
      previousEncrypted = row.mcp_config_encrypted
      // Credential refresh during discovery must not be overwritten by a rename.
      const refreshed = configFor(row)
      config.oauth = refreshed.oauth
      encrypted = encryptProviderKey(
        JSON.stringify(config),
        ctx.projectId,
        `build-mcp:${id}`
      )
    } else await withClient(config, toolsFor)
  } catch (error) {
    // SDK errors may contain endpoint query strings, remote content or credentials.
    throw new TracerError(
      "VALIDATION_ERROR",
      error instanceof Error &&
        /^(Use a public HTTPS|Remove the fragment|This MCP server requires)/.test(
          error.message
        )
        ? error.message
        : "Unable to connect to this MCP server. Check its public HTTPS URL and access token, then try again."
    )
  }
  publicUrl.search = ""
  const displayUrl = publicUrl.href
  const hasToken = Boolean(config.token || config.oauth?.tokens?.access_token)
  if (parsed.connectionId) {
    // Do not overwrite a disconnect that completed while the network check was running.
    const result = await ctx.database.execute(sql`
      UPDATE build_app_connections SET label=${parsed.name},mcp_url=${displayUrl},mcp_has_token=${hasToken},mcp_auth_type=${authType},mcp_config_encrypted=${encrypted},status='active',updated_at=now()
      WHERE id=${id}::uuid AND project_id=${ctx.projectId} AND mcp_config_encrypted IS NOT DISTINCT FROM ${previousEncrypted} RETURNING id
    `)
    if (!result.rows.length)
      throw new TracerError(
        "VALIDATION_ERROR",
        "The connection changed. Refresh Integrations and try again."
      )
  } else {
    const result = await ctx.database.execute(sql`
      INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status,mcp_url,mcp_has_token,mcp_auth_type,mcp_config_encrypted)
      VALUES(${id}::uuid,${ctx.projectId},${ctx.idempotencyKey ?? id},${CUSTOM_MCP_TOOLKIT},${parsed.name},${composioUserId(ctx.organizationId, ctx.projectId)},'custom-mcp-v1','active',${displayUrl},${hasToken},${authType},${encrypted})
      ON CONFLICT(project_id,request_key) DO NOTHING RETURNING id
    `)
    if (!result.rows.length)
      throw new TracerError(
        "VALIDATION_ERROR",
        "This connection request was already attempted. Refresh Integrations."
      )
  }
  let enabled:
    | Awaited<
        ReturnType<(typeof import("./mcp-agent-tools"))["enableMcpTools"]>
      >
    | undefined
  let toolsReady = true
  if (parsed.agentId) {
    try {
      enabled = await (
        await import("./mcp-agent-tools")
      ).enableMcpTools(ctx, parsed.agentId, id)
    } catch {
      toolsReady = false
    }
  }
  return {
    id,
    toolkit: CUSTOM_MCP_TOOLKIT,
    label: parsed.name,
    status: "active" as const,
    mcpUrl: displayUrl,
    hasToken,
    authType,
    ...(parsed.agentId
      ? {
          toolsReady,
          agentToolCount: enabled?.enabled ?? 0,
          agentRevision: enabled?.agentRevision,
        }
      : {}),
  }
}

export async function checkCustomMcpConnection(
  row: CustomMcpRow,
  database?: TracerDatabase
) {
  await withSavedClient(row, database, toolsFor)
  return row.mcp_config_encrypted
}
