import { handleMcp, mcpOptions } from "@/src/server/mcp/http"
import { authenticate, McpAuthError } from "@/src/server/mcp/auth"
import { getTracerService } from "@/src/server/tracer/service"
import {
  createTraceExplorerServer,
  traceExplorerConfig,
} from "@/src/server/mcp/trace-explorer"

export const runtime = "nodejs"
export const maxDuration = 120
export const dynamic = "force-dynamic"
export const POST = (request: Request) =>
  handleMcp(request, {
    config: traceExplorerConfig,
    authenticate: async (request, config) => {
      const identity = await authenticate(request, config)
      if (!identity.scopes.includes("traces:read"))
        throw new McpAuthError("Trace read permission is required.", 403)
      return identity
    },
    service: getTracerService,
    createServer: (service, scopes) =>
      createTraceExplorerServer(
        scopes.includes("traces:read") ? service : null,
        traceExplorerConfig()
      ),
    publicServer: (error) =>
      createTraceExplorerServer(null, traceExplorerConfig(), error),
  })
export const GET = POST
export const DELETE = POST
export const OPTIONS = (request: Request) =>
  mcpOptions(request, traceExplorerConfig)
