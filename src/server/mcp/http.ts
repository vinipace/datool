import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { getTracerService } from "../tracer/service"
import { withWorkspace } from "@/src/server/auth/context"
import { createMcpServer } from "./server"
import { agentRequestMaxBytes } from "@/src/lib/tracer/dataset-payload"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { TracerService } from "../tracer/service"
import {
  authenticate,
  authFailure,
  checkOrigin,
  mcpConfig,
  McpAuthError,
  type McpConfig,
  type McpIdentity,
} from "./auth"

type McpDependencies = {
  config: () => McpConfig
  authenticate: typeof authenticate
  service: (projectId: string) => Promise<TracerService>
  createServer?: typeof createMcpServer
  publicServer?: (error: McpAuthError) => McpServer
}

// Build knowledge files use JSON-safe base64. Keep one bounded MCP envelope
// limit large enough for the documented 20 MiB source limit plus encoding and
// schema overhead, while retaining a hard cap for every other operation.
const MAX_MCP_REQUEST_BYTES = 32 * 1024 * 1024

export async function handleMcp(
  request: Request,
  dependencies: McpDependencies = {
    config: mcpConfig,
    authenticate,
    service: getTracerService,
  }
) {
  let config: McpConfig | undefined
  try {
    config = dependencies.config()
    checkOrigin(request, config)
    let identity: McpIdentity | undefined
    let authError: McpAuthError | undefined
    try {
      identity = await dependencies.authenticate(request, config)
    } catch (error) {
      if (
        request.method !== "POST" ||
        !dependencies.publicServer ||
        !(error instanceof McpAuthError) ||
        ![401, 403].includes(error.status)
      )
        throw error
      authError = error
    }
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      })
    if (Number(request.headers.get("content-length")) > MAX_MCP_REQUEST_BYTES)
      throw new McpAuthError("Request exceeds 32 MiB.", 413)
    const reader = request.body?.getReader()
    if (!reader) throw new McpAuthError("JSON body required.", 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_MCP_REQUEST_BYTES) {
        await reader.cancel()
        throw new McpAuthError("Request exceeds 32 MiB.", 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new McpAuthError("Invalid JSON body.", 400)
    }
    const message = parsedBody as { method?: unknown; params?: { name?: unknown } } | null
    const maxBytes = message?.method === "tools/call" && typeof message.params?.name === "string" && message.params.name.startsWith("build_") ? MAX_MCP_REQUEST_BYTES : agentRequestMaxBytes(message?.method === "tools/call" ? message.params?.name : undefined)
    if (size > maxBytes) throw new McpAuthError(`Request exceeds ${maxBytes / (1024 * 1024)} MiB.`, 413)
    const respond = async () => {
      const server = authError
        ? dependencies.publicServer!(authError)
        : (dependencies.createServer ?? createMcpServer)(
            await dependencies.service(identity!.projectId),
            identity!.scopes
          )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      try {
        await server.connect(transport)
        const response = await transport.handleRequest(request, { parsedBody })
        // JSON-only stateless transport: finish response before disposing the request server.
        const body = await response.arrayBuffer()
        const headers = new Headers(response.headers)
        headers.set("Cache-Control", "no-store")
        const origin = request.headers.get("origin")
        if (origin) {
          headers.set("Access-Control-Allow-Origin", origin)
          headers.set("Vary", "Origin")
        }
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          headers,
        })
      } finally {
        await server.close()
      }
    }
    return identity
      ? await withWorkspace(
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
          respond
        )
      : await respond()
  } catch (error) {
    const response = authFailure(error, config)
    const origin = request.headers.get("origin")
    if (
      config &&
      origin &&
      (origin === new URL(config.resource).origin ||
        config.origins.includes(origin))
    ) {
      response.headers.set("Access-Control-Allow-Origin", origin)
      response.headers.set("Access-Control-Expose-Headers", "WWW-Authenticate")
      response.headers.set("Vary", "Origin")
    }
    return response
  }
}
export function mcpOptions(request: Request, configFactory = mcpConfig) {
  try {
    const config = configFactory()
    checkOrigin(request, config)
    const headers = new Headers({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Project-Id",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
      Vary: "Origin",
    })
    const origin = request.headers.get("origin")
    if (origin) headers.set("Access-Control-Allow-Origin", origin)
    return new Response(null, { status: 204, headers })
  } catch (error) {
    return authFailure(error)
  }
}
