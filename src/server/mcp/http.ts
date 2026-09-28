import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { getTracerService } from "../tracer/service"
import { withWorkspace } from "@/src/server/auth/context"
import { createMcpServer } from "./server"
import { agentRequestMaxBytes, DATASET_WRITE_MAX_BYTES } from "@/src/lib/tracer/dataset-payload"
import {
  authenticate,
  authFailure,
  checkOrigin,
  mcpConfig,
  McpAuthError,
  type McpConfig,
} from "./auth"

export async function handleMcp(
  request: Request,
  dependencies = { config: mcpConfig, authenticate, service: getTracerService }
) {
  let config: McpConfig | undefined
  try {
    config = dependencies.config()
    checkOrigin(request, config)
    const identity = await dependencies.authenticate(request, config)
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST, OPTIONS" },
      })
    if (Number(request.headers.get("content-length")) > DATASET_WRITE_MAX_BYTES)
      throw new McpAuthError("Request exceeds 4 MiB.", 413)
    const reader = request.body?.getReader()
    if (!reader) throw new McpAuthError("JSON body required.", 400)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DATASET_WRITE_MAX_BYTES) {
        await reader.cancel()
        throw new McpAuthError("Request exceeds 4 MiB.", 413)
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
    const maxBytes = agentRequestMaxBytes(message?.method === "tools/call" ? message.params?.name : undefined)
    if (size > maxBytes) throw new McpAuthError(`Request exceeds ${maxBytes / (1024 * 1024)} MiB.`, 413)
    return await withWorkspace({ organizationId: identity.organizationId, projectId: identity.projectId, userId: identity.kind === "api-key" ? undefined : identity.subject, apiKeyId: identity.apiKeyId, apiKeyName: identity.apiKeyName, clientId: identity.clientId, scopes: identity.scopes, kind: identity.kind ?? "oauth" }, async () => {
    const server = createMcpServer(await dependencies.service(identity.projectId), identity.scopes)
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
    })
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
export function mcpOptions(request: Request) {
  try {
    const config = mcpConfig()
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
