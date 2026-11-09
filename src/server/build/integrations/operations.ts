import { configureShopifyChat } from "./shopify"
import { getAgentUsage } from "../usage"
import { assertBuildProject } from "../context"
import { getTracerWritePool } from "@/src/server/tracer/db"
import { z } from "zod"
import { saveMcpConnection, saveMcpConnectionSchema } from "./custom-mcp"
import { startMcpOAuth, startMcpOAuthSchema } from "./mcp-oauth"
import { enableMcpTools } from "./mcp-agent-tools"
import { registerBuildOperation } from "../api"
import {
  connectApp,
  disconnectApp,
  listAppConnections,
  listAppTools,
  refreshAppConnection,
} from "./service"
const id = z.string().uuid()
registerBuildOperation({
  name: "build_enable_mcp_tools",
  description:
    "Discover a connected custom MCP server's tools, add missing tools to this agent's Actions and publish the updated catalog. Preserves existing action settings and other agents. Requires project write access.",
  scopes: ["build:write"],
  schema: z.object({ agentId: z.string().min(1).max(200), connectionId: id }),
  idempotency: "required",
  openWorld: true,
  execute: (ctx, input) =>
    enableMcpTools(ctx, String(input.agentId), String(input.connectionId)),
})
registerBuildOperation({
  name: "build_start_mcp_oauth",
  description:
    "Start OAuth authorization for a custom MCP server. Discovers authorization metadata, registers the client when supported, and returns the sign-in URL. Requires a signed-in project member. Credentials are encrypted.",
  scopes: ["build:write"],
  schema: startMcpOAuthSchema,
  idempotency: "required",
  openWorld: true,
  execute: (ctx, input) => startMcpOAuth(ctx, startMcpOAuthSchema.parse(input)),
})
registerBuildOperation({
  name: "build_save_mcp_connection",
  description:
    "Connect or update a custom Streamable HTTP MCP server by public HTTPS URL, with an optional bearer access token. Supply agentId to import and publish its tools for that agent. Omit url or token on updates to retain them; an empty token removes it. Verifies discovery before saving. Credentials are encrypted and never returned. For OAuth sign-in, use build_start_mcp_oauth.",
  scopes: ["build:write"],
  schema: saveMcpConnectionSchema,
  idempotency: "required",
  openWorld: true,
  execute: (ctx, input) =>
    saveMcpConnection(ctx, saveMcpConnectionSchema.parse(input)),
})
registerBuildOperation({
  name: "build_list_app_connections",
  description:
    "List enabled apps and project-owned connections. No credentials are returned.",
  scopes: ["build:read"],
  schema: z.object({ agentId: z.string().min(1).max(200).optional() }),
  execute: (ctx, input) =>
    listAppConnections(
      ctx,
      typeof input.agentId === "string" ? input.agentId : undefined
    ),
})
registerBuildOperation({
  name: "build_connect_app",
  description:
    "Start a private OAuth app connection for the current project. Open the returned HTTPS URL to authorize.",
  scopes: ["build:write"],
  schema: z.object({
    toolkit: z.string().min(1).max(100),
    shop: z.string().max(260).optional(),
  }),
  idempotency: "required",
  openWorld: true,
  execute: (ctx, input) =>
    connectApp(
      ctx,
      String(input.toolkit),
      typeof input.shop === "string" ? input.shop : undefined
    ),
})
registerBuildOperation({
  name: "build_refresh_app_connection",
  description:
    "Verify an app's OAuth status or check a custom MCP server. Callback parameters cannot activate connections.",
  scopes: ["build:write"],
  schema: z.object({ connectionId: id }),
  openWorld: true,
  execute: (ctx, input) =>
    refreshAppConnection(ctx, String(input.connectionId)),
})
registerBuildOperation({
  name: "build_disconnect_app",
  description:
    "Disconnect a project app and revoke its use by all agent revisions.",
  scopes: ["build:write"],
  schema: z.object({ connectionId: id }),
  destructive: true,
  openWorld: true,
  execute: (ctx, input) => disconnectApp(ctx, String(input.connectionId)),
})
registerBuildOperation({
  name: "build_list_app_tools",
  description:
    "List approved actions and schemas for an active project app connection.",
  scopes: ["build:read"],
  schema: z.object({ connectionId: id }),
  openWorld: true,
  execute: (ctx, input) => listAppTools(ctx, String(input.connectionId)),
})

registerBuildOperation({
  name: "build_get_usage",
  description:
    "Read model tokens and integration calls by agent and conversation within the current paid period (UTC month for self-hosting). Summaries include all events; breakdowns return the 100 most recently active groups.",
  scopes: ["build:read"],
  schema: z.object({
    agentId: z.string().min(1).max(200).optional(),
    conversationId: z.string().min(1).max(200).optional(),
  }),
  execute: async (context, input) => {
    const ctx = await assertBuildProject(context)
    return getAgentUsage(
      ctx.organizationId,
      { projectId: ctx.projectId, ...input },
      getTracerWritePool(ctx.database)
    )
  },
})

registerBuildOperation({
  name: "build_configure_shopify_chat",
  description:
    "Connect the installed Shopify app's storefront chat to an enabled project web channel. The merchant must enable the Datool chat app embed in the theme editor.",
  scopes: ["build:write"],
  schema: z.object({ connectionId: id, channelId: id }),
  idempotency: "required",
  openWorld: true,
  execute: (context, input) =>
    configureShopifyChat(
      context,
      String(input.connectionId),
      String(input.channelId)
    ),
})
