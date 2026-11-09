import { isShopifyCartTool } from "@/src/lib/build/shopify-cart"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  AppConnection,
  IntegrationCatalog,
  IntegrationTool,
} from "@/src/lib/build/integrations"
import { billingEnabled } from "@/src/server/billing/config"
import { ExecutionCreditStore } from "@/src/server/execution-credits/ledger"
import { getTracerWritePool } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "../context"
import { SHOPIFY_TOOLKIT, shopifyConfigured } from "./shopify-provider"
import {
  connectShopify,
  executeShopifyTool,
  refreshShopifyConnection,
} from "./shopify"
import { shopifyTools } from "./shopify-tools"
import {
  CUSTOM_MCP_TOOLKIT,
  callCustomMcpTool,
  checkCustomMcpConnection,
  listCustomMcpTools,
} from "./custom-mcp"
import { McpRuntimeError } from "./mcp-errors"
import {
  authorizeSession,
  executeSession,
  composioClient,
  composioUserId,
  integrationApp,
  integrationConfig,
  integrationSession,
} from "./provider"

type ConnectionRow = {
  id: string
  project_id: string
  toolkit: string
  label: string
  status: AppConnection["status"]
  provider_user_id: string
  auth_config_id: string
  connected_account_id: string | null
  mcp_config_encrypted: string | null
  mcp_url: string | null
  mcp_has_token: boolean
  mcp_auth_type: "none" | "token" | "oauth"
}
const publicConnection = (row: ConnectionRow): AppConnection => ({
  id: row.id,
  toolkit: row.toolkit,
  label: row.label,
  status: row.status,
  ...(row.toolkit === CUSTOM_MCP_TOOLKIT
    ? {
        mcpUrl: row.mcp_url ?? undefined,
        hasToken: row.mcp_has_token,
        authType: row.mcp_auth_type,
      }
    : {}),
})
const unavailable = () =>
  new TracerError(
    "VALIDATION_ERROR",
    "The app connection is unavailable. Refresh or reconnect it in Integrations."
  )

async function ownedConnection(context: BuildContext, id: string) {
  const ctx = await assertBuildProject(context)
  const { rows } = await ctx.database.execute<ConnectionRow>(
    sql`SELECT * FROM build_app_connections WHERE project_id=${ctx.projectId} AND id=${id}::uuid`
  )
  const row = rows[0]
  if (
    !row ||
    row.provider_user_id !== composioUserId(ctx.organizationId, ctx.projectId)
  )
    throw unavailable()
  return row
}
export async function listAppConnections(
  context: BuildContext,
  agentId?: string
): Promise<IntegrationCatalog> {
  await assertBuildProject(context)
  const config = integrationConfig()
  const toolCounts = new Map<string, number>()
  if (agentId) {
    const { getAgent } = await import("../agents")
    const { getRuntimeAppliedDefinitions } = await import("../definitions")
    const agent = await getAgent(context, agentId)
    const catalog = await getRuntimeAppliedDefinitions(
      context,
      agentId,
      agent.appliedRevision ?? undefined
    )
    for (const item of catalog.actions)
      if (item.definition.type === "integration" && item.definition.enabled)
        toolCounts.set(
          item.definition.connectionId,
          (toolCounts.get(item.definition.connectionId) ?? 0) + 1
        )
  }
  const { rows } = await context.database.execute<ConnectionRow>(
    sql`SELECT * FROM build_app_connections WHERE project_id=${context.projectId} ORDER BY created_at DESC LIMIT 100`
  )
  return {
    configured: true,
    apps: [
      {
        slug: SHOPIFY_TOOLKIT,
        name: "Shopify",
        connectionMethod: "shopify",
        available:
          shopifyConfigured() && Boolean(process.env.DATOOL_SHOPIFY_APP_HANDLE),
      },
      ...Object.entries(config).map(([slug, app]) => ({
        slug,
        name: app.name,
        available: Boolean(process.env.COMPOSIO_API_KEY),
      })),
    ],
    connections: rows.map((row) => ({
      ...publicConnection(row),
      ...(agentId && row.toolkit === CUSTOM_MCP_TOOLKIT
        ? { agentToolCount: toolCounts.get(row.id) ?? 0 }
        : {}),
    })),
  }
}
export async function connectApp(
  context: BuildContext,
  toolkit: string,
  shop?: string
) {
  if (toolkit === SHOPIFY_TOOLKIT) return connectShopify(context, shop ?? "")
  const ctx = await assertBuildProject(context)
  const app = integrationApp(toolkit)
  const id = randomUUID()
  const userId = composioUserId(ctx.organizationId, ctx.projectId)
  // Persist intent before starting OAuth; never accept a provider account ID from a browser.
  const admitted = await ctx.database
    .execute(sql`INSERT INTO build_app_connections(id,project_id,request_key,toolkit,label,provider_user_id,auth_config_id,status)
    VALUES(${id}::uuid,${ctx.projectId},${ctx.idempotencyKey ?? id},${toolkit},${app.name},${userId},${app.authConfigId},'pending') ON CONFLICT(project_id,request_key) DO NOTHING RETURNING id`)
  if (!admitted.rows.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "This connection request was already attempted. Refresh your connections before starting a new one."
    )
  const credits = new ExecutionCreditStore(getTracerWritePool(ctx.database))
  let reserved = false
  let dispatched = false
  try {
    const session = await integrationSession(userId, toolkit)
    if (billingEnabled() && app.connectionCostNanoUsd > 0) {
      await credits.reserve(
        ctx.projectId,
        "integration",
        app.connectionCostNanoUsd,
        `composio:connect:${toolkit}:${app.connectionCostNanoUsd}:v1`,
        id
      )
      reserved = true
      await credits.recordEvidence(id, null, {
        kind: "connection",
        connectionId: id,
        toolkit,
        sessionId: session.sessionId,
      })
    }
    dispatched = true
    const request = await authorizeSession(session, toolkit)
    const url = new URL(request.redirectUrl || "")
    if (url.protocol !== "https:") throw unavailable()
    await ctx.database.execute(
      sql`UPDATE build_app_connections SET connected_account_id=${request.id},updated_at=now() WHERE id=${id}::uuid AND project_id=${ctx.projectId}`
    )
    if (reserved)
      await credits.settle(id, app.connectionCostNanoUsd, request.id, {
        kind: "connection",
        connectionId: id,
        toolkit,
        result: "completed",
      })
    return { id, redirectUrl: url.toString() }
  } catch {
    if (reserved && !dispatched)
      await credits.settle(id, 0, null, {
        dispatched: false,
        kind: "connection",
        connectionId: id,
      })
    await ctx.database.execute(
      sql`UPDATE build_app_connections SET status='failed',updated_at=now() WHERE id=${id}::uuid AND project_id=${ctx.projectId}`
    )
    throw new TracerError(
      "VALIDATION_ERROR",
      dispatched
        ? "Unable to confirm the app connection. Refresh connections before starting again; credits may remain reserved."
        : "Unable to start the app connection. Check available execution credits and try again."
    )
  }
}
export async function refreshAppConnection(context: BuildContext, id: string) {
  const row = await ownedConnection(context, id)
  if (row.toolkit === CUSTOM_MCP_TOOLKIT) {
    if (row.status === "disconnected") return publicConnection(row)
    if (row.status === "pending" && row.mcp_auth_type === "oauth")
      return publicConnection(row)
    let status: AppConnection["status"] = "active"
    try {
      await checkCustomMcpConnection(row, context.database)
    } catch {
      status = "failed"
    }
    const updated = await context.database.execute<ConnectionRow>(sql`
      UPDATE build_app_connections SET status=${status},updated_at=now()
      WHERE id=${id}::uuid AND project_id=${context.projectId} AND status<>'disconnected'
        AND mcp_config_encrypted=${row.mcp_config_encrypted} RETURNING *
    `)
    return publicConnection(
      updated.rows[0] ?? (await ownedConnection(context, id))
    )
  }
  if (row.toolkit === SHOPIFY_TOOLKIT) {
    if (row.status === "active") await refreshShopifyConnection(context, id)
    return publicConnection(await ownedConnection(context, id))
  }
  if (row.status === "disconnected" || !row.connected_account_id)
    return publicConnection(row)
  const app = integrationApp(row.toolkit)
  try {
    const account = await composioClient().connectedAccounts.get(
      row.connected_account_id,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (
      account.toolkit.slug !== row.toolkit ||
      account.authConfig.id !== row.auth_config_id ||
      app.authConfigId !== row.auth_config_id ||
      account.experimental?.accountType === "SHARED"
    )
      throw unavailable()
    const status: AppConnection["status"] =
      account.status === "ACTIVE" && !account.isDisabled
        ? "active"
        : ["INITIATED", "INITIALIZING"].includes(account.status)
          ? "pending"
          : "failed"
    // A concurrent disconnect must never be resurrected by a slow refresh.
    const updated = await context.database.execute<ConnectionRow>(
      sql`UPDATE build_app_connections SET status=${status},updated_at=now() WHERE id=${id}::uuid AND project_id=${context.projectId} AND status<>'disconnected' RETURNING *`
    )
    return updated.rows[0]
      ? publicConnection(updated.rows[0])
      : { ...publicConnection(row), status: "disconnected" as const }
  } catch {
    throw unavailable()
  }
}
export async function disconnectApp(context: BuildContext, id: string) {
  const row = await ownedConnection(context, id)
  if (row.toolkit === CUSTOM_MCP_TOOLKIT) {
    await context.database.execute(
      sql`DELETE FROM build_mcp_oauth_requests WHERE connection_id=${id}::uuid AND project_id=${context.projectId}`
    )
    await context.database.execute(sql`
      UPDATE build_app_connections SET status='disconnected',mcp_config_encrypted=NULL,mcp_has_token=false,updated_at=now()
      WHERE id=${id}::uuid AND project_id=${context.projectId}
    `)
    return {
      ...publicConnection(row),
      status: "disconnected" as const,
      hasToken: false,
    }
  }
  // Revoke local authorization first, even when the upstream API is unavailable.
  await context.database.execute(
    sql`UPDATE build_app_connections SET status='disconnected',updated_at=now() WHERE id=${id}::uuid AND project_id=${context.projectId}`
  )
  if (row.toolkit === SHOPIFY_TOOLKIT) {
    await context.database.execute(
      sql`UPDATE build_shopify_connections SET session_encrypted=NULL,start_token_hash=NULL,oauth_state_hash=NULL WHERE connection_id=${id}::uuid AND project_id=${context.projectId}`
    )
    return { ...publicConnection(row), status: "disconnected" as const }
  }
  if (row.connected_account_id) {
    try {
      await composioClient().connectedAccounts.delete(
        row.connected_account_id,
        { signal: AbortSignal.timeout(10_000) }
      )
    } catch {
      throw new TracerError(
        "VALIDATION_ERROR",
        "Disconnected in Datool. Provider cleanup failed; retry Disconnect to remove the remote connection."
      )
    }
  }
  return { ...publicConnection(row), status: "disconnected" as const }
}
export async function listAppTools(
  context: BuildContext,
  connectionId: string
): Promise<IntegrationTool[]> {
  const row = await ownedConnection(context, connectionId)
  if (row.status !== "active") throw unavailable()
  if (row.toolkit === CUSTOM_MCP_TOOLKIT)
    return listCustomMcpTools(row, context.database)
  if (row.toolkit === SHOPIFY_TOOLKIT) {
    if (!shopifyConfigured()) throw unavailable()
    return shopifyTools
  }
  const app = integrationApp(row.toolkit)
  try {
    const tools = await composioClient().tools.getRawComposioTools(
      { tools: app.tools },
      undefined,
      { signal: AbortSignal.timeout(15_000) }
    )
    return tools
      .filter(
        (tool) =>
          tool.toolkit?.slug === row.toolkit &&
          app.tools.includes(tool.slug) &&
          !tool.isDeprecated
      )
      .map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputParameters || { type: "object", properties: {} },
      }))
  } catch {
    throw new TracerError(
      "VALIDATION_ERROR",
      "Unable to load the app actions. Try again shortly."
    )
  }
}
export async function validateAppAction(
  context: BuildContext,
  connectionId: string,
  toolSlug: string
) {
  const tools = await listAppTools(context, connectionId)
  const tool = tools.find((tool) => tool.slug === toolSlug)
  if (!tool)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Choose an enabled action from this app connection."
    )
  return tool
}

/** Called only from the applied action runtime, including procedures and approved continuations. */
export async function executeAppAction(
  context: BuildContext,
  input: {
    connectionId: string
    toolSlug: string
    agentId: string
    conversationId: string
    turnId: string
    toolCallId: string
    arguments: Record<string, unknown>
    shopifyConfirmed?: boolean
    shopifyCartResult?: unknown
    shopifyPrepareReturn?: boolean
    shopifyReturnQuote?: import("@/src/lib/build/shopify-return").ShopifyReturnQuote
    shopifyPrepareOrder?: boolean
    shopifyOrderQuote?: import("@/src/lib/build/shopify-order").ShopifyOrderQuote
    shopifySourceTurnId?: string
    shopifySettings?: import("@/src/lib/build/shopify").ShopifyActionSettings
    signal?: AbortSignal
  }
) {
  const ctx = await assertBuildProject(context)
  const connection = await ownedConnection(ctx, input.connectionId)
  const native = connection.toolkit === SHOPIFY_TOOLKIT
  const customMcp = connection.toolkit === CUSTOM_MCP_TOOLKIT
  if (
    connection.status !== "active" ||
    (!native && !customMcp && !connection.connected_account_id)
  )
    throw unavailable()
  const app = customMcp
    ? {
        authConfigId: "custom-mcp-v1",
        tools: (await listCustomMcpTools(connection, ctx.database)).map(
          (tool) => tool.slug
        ),
        costNanoUsd: 0,
      }
    : native
      ? {
          authConfigId: "shopify-native-v1",
          tools: shopifyTools.map((tool) => tool.slug),
          costNanoUsd: 0,
        }
      : integrationApp(connection.toolkit)
  if (
    app.authConfigId !== connection.auth_config_id ||
    !app.tools.includes(input.toolSlug)
  )
    throw unavailable()
  const ownership = await ctx.database.execute<{
    channel: string
  }>(sql`SELECT c.channel FROM build_conversation_turns t JOIN build_conversations c ON c.id=t.conversation_id AND c.project_id=t.project_id
    WHERE t.id=${input.turnId} AND t.project_id=${ctx.projectId} AND c.id=${input.conversationId} AND c.agent_id=${input.agentId}`)
  if (!ownership.rows.length) throw unavailable()
  // Preparing a browser interaction has no external effect or integration usage.
  // The existing tool ledger persists the one-shot continuation before it reaches the shopper.
  if (
    native &&
    ((isShopifyCartTool(input.toolSlug) &&
      input.shopifyCartResult === undefined &&
      ownership.rows[0].channel === "web") ||
      (input.toolSlug === "SHOPIFY_CREATE_ORDER" &&
        input.shopifyPrepareOrder) ||
      (input.toolSlug === "SHOPIFY_RETURN_OR_EXCHANGE" &&
        input.shopifyPrepareReturn))
  ) {
    const output = await executeShopifyTool(
      ctx,
      connection.id,
      input.toolSlug,
      input.arguments,
      input.signal,
      {
        conversationId: input.conversationId,
        confirmed: input.shopifyConfirmed,
        turnId: input.turnId,
        identityTurnId: input.shopifySourceTurnId,
        prepareOrder: input.shopifyPrepareOrder,
        prepareReturn: input.shopifyPrepareReturn,
        cartResult: input.shopifyCartResult,
        settings: input.shopifySettings,
      }
    )
    return {
      output,
      status:
        "cartCommand" in output ||
        input.shopifyPrepareOrder ||
        input.shopifyPrepareReturn
          ? ("awaiting_client" as const)
          : ("completed" as const),
    }
  }
  const id = randomUUID()
  const admitted = await ctx.database
    .execute(sql`INSERT INTO build_usage_event(id,organization_id,project_id,agent_id,conversation_id,turn_id,event_key,kind,provider,toolkit,tool_slug,connection_id,status,cost_source)
    VALUES(${id}::uuid,${ctx.organizationId},${ctx.projectId},${input.agentId},${input.conversationId},${input.turnId},${`integration:${input.turnId}:${input.toolCallId}`},'integration',${customMcp ? "mcp" : native ? "shopify" : "composio"},${connection.toolkit},${input.toolSlug},${connection.id}::uuid,'pending','configured')
    ON CONFLICT(project_id,event_key) DO NOTHING RETURNING id`)
  if (!admitted.rows.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "This app action was already attempted. Inspect its result before retrying."
    )
  if (customMcp) {
    let dispatched = false
    try {
      const output = await callCustomMcpTool(
        connection,
        input.toolSlug,
        input.arguments,
        async () => {
          const latest = await ownedConnection(ctx, connection.id)
          if (
            latest.status !== "active" ||
            latest.mcp_config_encrypted !== connection.mcp_config_encrypted
          )
            throw unavailable()
          dispatched = true
        },
        input.signal,
        ctx.database
      )
      const status = output.isError
        ? ("failed" as const)
        : ("completed" as const)
      await ctx.database.execute(
        sql`UPDATE build_usage_event SET status=${status},cost_nano_usd=0 WHERE id=${id}::uuid`
      )
      return { output, status }
    } catch (cause) {
      await ctx.database.execute(
        sql`UPDATE build_usage_event SET status=${dispatched ? "uncertain" : "blocked"},cost_nano_usd=0 WHERE id=${id}::uuid`
      )
      if (!dispatched && cause instanceof McpRuntimeError) throw cause
      throw new McpRuntimeError(
        dispatched ? "ACTION_UNCERTAIN" : "MCP_ACTION_NOT_STARTED",
        dispatched
          ? "The MCP action outcome is uncertain. Check the connected app before retrying."
          : "The MCP action could not start. Check its connection in Integrations.",
        {
          stage: dispatched ? "execution" : "preflight",
          connectionId: connection.id,
          toolSlug: input.toolSlug,
          retryable: !dispatched,
        },
        cause
      )
    }
  }
  const commerceQuote = input.shopifyOrderQuote ?? input.shopifyReturnQuote
  if (native && commerceQuote)
    await ctx.database.execute(sql`
      UPDATE build_usage_event SET provider_session_id=${commerceQuote.operationId}
      WHERE id=${id}::uuid
    `)
  if (native) {
    try {
      const output = await executeShopifyTool(
        ctx,
        connection.id,
        input.toolSlug,
        input.arguments,
        input.signal,
        {
          conversationId: input.conversationId,
          turnId: input.turnId,
          identityTurnId: input.shopifySourceTurnId,
          confirmed: input.shopifyConfirmed,
          cartResult: input.shopifyCartResult,
          orderQuote: input.shopifyOrderQuote,
          returnQuote: input.shopifyReturnQuote,
          recordDraft: async (draftId) => {
            await ctx.database.execute(
              sql`UPDATE build_usage_event SET provider_log_id=${draftId} WHERE id=${id}::uuid`
            )
          },
          settings: input.shopifySettings,
        }
      )
      const needsReview =
        ["SHOPIFY_CREATE_ORDER", "SHOPIFY_RETURN_OR_EXCHANGE"].includes(
          input.toolSlug
        ) && (output as { status?: string }).status === "needs_review"
      await ctx.database.execute(
        sql`UPDATE build_usage_event SET status=${needsReview ? "uncertain" : "completed"},cost_nano_usd=0 WHERE id=${id}::uuid`
      )
      return { output, status: "completed" as const }
    } catch (error) {
      await ctx.database.execute(
        sql`UPDATE build_usage_event SET status=${(error as { uncertain?: boolean })?.uncertain ? "uncertain" : "failed"},cost_nano_usd=0 WHERE id=${id}::uuid`
      )
      throw error
    }
  }
  const credits = new ExecutionCreditStore(getTracerWritePool(ctx.database))
  let reserved = false
  let dispatched = false
  try {
    const session = await integrationSession(
      connection.provider_user_id,
      connection.toolkit,
      connection.connected_account_id!,
      input.toolSlug
    )
    if (billingEnabled()) {
      await credits.reserve(
        ctx.projectId,
        "integration",
        app.costNanoUsd,
        `composio:${connection.toolkit}:${app.costNanoUsd}:v1`,
        id
      )
      reserved = true
      await ctx.database.execute(
        sql`UPDATE build_usage_event SET credit_operation_id=${id}::uuid WHERE id=${id}::uuid`
      )
    }
    await ctx.database.execute(
      sql`UPDATE build_usage_event SET provider_session_id=${session.sessionId} WHERE id=${id}::uuid`
    )
    if (reserved)
      await credits.recordEvidence(id, null, {
        sessionId: session.sessionId,
        toolkit: connection.toolkit,
        tool: input.toolSlug,
        agentId: input.agentId,
        conversationId: input.conversationId,
        turnId: input.turnId,
      })
    input.signal?.throwIfAborted()
    // Recheck revocation immediately before dispatch, after session creation and admission.
    if ((await ownedConnection(ctx, connection.id)).status !== "active")
      throw unavailable()
    dispatched = true
    const result = await executeSession(
      session,
      input.toolSlug,
      input.arguments,
      input.signal
    )
    if (reserved)
      await credits.settle(id, app.costNanoUsd, result.logId, {
        toolkit: connection.toolkit,
        tool: input.toolSlug,
        agentId: input.agentId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        result: result.resultType,
      })
    await ctx.database.execute(
      sql`UPDATE build_usage_event SET status=${result.resultType === "completed" ? "completed" : "failed"},cost_nano_usd=${app.costNanoUsd},provider_log_id=${result.logId} WHERE id=${id}::uuid`
    )
    return {
      output:
        result.resultType === "completed"
          ? result.data
          : { error: "The connected app could not complete this action." },
      status:
        result.resultType === "completed"
          ? ("completed" as const)
          : ("failed" as const),
    }
  } catch {
    if (reserved && !dispatched)
      await credits.settle(id, 0, null, { dispatched: false })
    await ctx.database.execute(
      sql`UPDATE build_usage_event SET status=${dispatched ? "uncertain" : "blocked"} WHERE id=${id}::uuid`
    )
    const error = new TracerError(
      "VALIDATION_ERROR",
      dispatched
        ? "The app action outcome is uncertain. Check the app before retrying; credits may remain reserved."
        : "The app action could not start. Check the connection and available execution credits.",
      { status: dispatched ? 502 : 402 }
    )
    Object.assign(error, { uncertain: dispatched })
    throw error
  }
}
