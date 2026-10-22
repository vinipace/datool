import { getAgentUsage } from "../usage"
import { assertBuildProject } from "../context"
import { getTracerWritePool } from "@/src/server/tracer/db"
import { z } from "zod"
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
  name: "build_list_app_connections",
  description:
    "List enabled apps and project-owned connections. No credentials are returned.",
  scopes: ["build:read"],
  schema: z.object({}),
  execute: (ctx) => listAppConnections(ctx),
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
    "Verify the provider's OAuth connection status. Callback parameters cannot activate connections.",
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
