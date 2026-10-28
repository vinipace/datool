import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { buildEnabled } from "@/lib/build/config"
import { workspaceIdentity } from "@/src/server/auth/context"

import { asTracerError } from "@/src/server/tracer/errors"
import {
  buildOperations,
  buildOperationInputSchema,
  executeBuildOperation,
} from "./bootstrap"

/**
 * Register exactly the Build operations granted by the MCP token. The same
 * registry powers the REST route, so a tool cannot accidentally expose a UI
 * write that has no API or permission contract.
 */
export function registerBuildMcpTools(
  server: McpServer,
  scopes: readonly string[]
) {
  const describeTools: (() => Tool)[] = []
  if (!buildEnabled(workspaceIdentity()?.organizationId)) return describeTools
  for (const operation of buildOperations) {
    const discover = operation.name === "build_describe_operations"
    if (
      discover
        ? !scopes.some((scope) =>
            ["build:read", "build:write", "build:run"].includes(scope)
          )
        : !operation.scopes.every((scope) => scopes.includes(scope))
    )
      continue
    const schema = buildOperationInputSchema(operation)
    const metadata = {
        description: operation.description,
        annotations: {
          readOnlyHint: operation.scopes.every((scope) => scope === "build:read"),
          destructiveHint: operation.destructive ?? false,
          idempotentHint: operation.idempotent ?? false,
          openWorldHint: operation.openWorld ?? false,
        },
      }
    describeTools.push(() => ({
      name: operation.name,
      ...metadata,
      inputSchema: z.toJSONSchema(schema, {
        io: "input",
        target: "draft-2020-12",
      }) as Tool["inputSchema"],
    }))
    server.registerTool(
      operation.name,
      { ...metadata, inputSchema: schema.shape },
      async (input: unknown): Promise<CallToolResult> => {
        try {
          const data = await executeBuildOperation(operation.name, input)
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: { data },
          }
        } catch (error) {
          const problem = asTracerError(error, "Build operation failed.")
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  code: problem.code,
                  message: problem.message,
                  details: problem.details,
                }),
              },
            ],
          }
        }
      }
    )
  }
  return describeTools
}
