import { parseEnvironment } from "./context"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { getDeployment, invokeDeploymentTool } from "./service"
import type { DeploymentContext } from "./context"
import { TracerError } from "../tracer/errors"

export async function projectMcp(
  context: DeploymentContext,
  request: Request,
  parsedBody: unknown
) {
  context = {
    ...context,
    environment: parseEnvironment(
      new URL(request.url).searchParams.get("environment")
    ),
  }
  const deployment = await getDeployment(context)
  if (!deployment)
    throw new TracerError("NOT_FOUND", "Deploy a folder to this project first.")
  const server = new Server(
    { name: "datool-project", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deployment.tools_json.map((t) => ({
      ...t,
      inputSchema: t.inputSchema as { type: "object" },
      annotations: {
        readOnlyHint: t.name === "brain_search",
        openWorldHint: t.name !== "brain_search",
      },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await invokeDeploymentTool(
        context,
        deployment.id,
        params.name,
        params.arguments ?? {},
        request.signal
      )
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { result },
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error ? error.message : "Tool execution failed.",
          },
        ],
      }
    }
  })
  const documents = [
    ...deployment.bundle_json.sources,
    ...deployment.bundle_json.skills,
  ]
  const uri = (path: string) =>
    `datool://project/${encodeURIComponent(context.projectId)}/${deployment.environment}/${encodeURIComponent(path)}`
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: documents.map((d) => ({
      uri: uri(d.path),
      name: d.title,
      mimeType: "text/plain",
    })),
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    const document = documents.find((d) => uri(d.path) === params.uri)
    if (!document) throw new Error("Resource not found in this project.")
    return {
      contents: [
        { uri: params.uri, mimeType: "text/plain", text: document.text },
      ],
    }
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request, { parsedBody })
    const body = await response.arrayBuffer(),
      headers = new Headers(response.headers)
    headers.set("Cache-Control", "no-store")
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      headers,
    })
  } finally {
    await server.close()
  }
}
