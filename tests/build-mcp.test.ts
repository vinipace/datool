import { withWorkspace } from "@/src/server/auth/context"
import { configureBuildTestEnvironment } from "./helpers/build-env"
import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createMcpServer } from "@/src/server/mcp/server"
import type { TracerService } from "@/src/server/tracer/service"
import { buildOperationCatalog } from "@/src/server/build/bootstrap"

configureBuildTestEnvironment()

describe("Build MCP transport", () => {
  test("disabled Build is neither discoverable nor callable, while Observe tools remain", async () => {
    delete process.env.DATOOL_BUILD_ENABLED
    const server = createMcpServer({} as TracerService, ["build:read", "build:write", "build:run", "metrics:read"])
    const client = new Client({ name: "build-disabled-test", version: "1" })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain("query_metrics")
      expect(names.some((name) => name.startsWith("build_"))).toBe(false)
      const result = await client.callTool({ name: "build_list_agents", arguments: {} })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain("not found")
    } finally {
      await client.close()
      await server.close()
    }
  })

  test("allowlisted and excluded organizations receive different MCP catalogs", async () => {
    process.env.DATOOL_BUILD_ENABLED = "false"
    process.env.DATOOL_BUILD_ORGANIZATION_IDS = "org-allowed"
    for (const organizationId of ["org-allowed", "org-excluded"]) {
      await withWorkspace({ organizationId, projectId: "project-test", kind: "oauth", scopes: ["build:read", "metrics:read"] }, async () => {
        const server = createMcpServer({} as TracerService, ["build:read", "metrics:read"])
        const client = new Client({ name: "build-allowlist-test", version: "1" })
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
        try {
          await server.connect(serverTransport)
          await client.connect(clientTransport)
          const names = (await client.listTools()).tools.map((tool) => tool.name)
          expect(names).toContain("query_metrics")
          expect(names.includes("build_list_agents")).toBe(organizationId === "org-allowed")
        } finally {
          await client.close()
          await server.close()
        }
      })
    }
  })

  test("discovers read tools while omitting denied write and run tools", async () => {
    const server = createMcpServer({} as TracerService, ["build:read", "metrics:read"])
    const client = new Client({ name: "build-mcp-test", version: "1" })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const tools = (await client.listTools()).tools
    const names = tools.map((tool) => tool.name)
    expect(names).toContain("query_metrics")
    expect(names).toContain("get_metrics_metadata")
    expect(names).toContain("build_describe_operations")
    expect(names).toContain("build_list_agents")
    expect(names).toContain("build_list_conversation_messages")
    expect(names).not.toContain("build_create_agent")
    expect(names).not.toContain("build_run_agent_turn")
    const readNames = new Set(
      buildOperationCatalog(["build:read"]).map((operation) => operation.name)
    )
    expect(names.filter((name) => name.startsWith("build_")).every((name) => readNames.has(name))).toBe(true)

    await client.close()
    await server.close()
  })

  test("publishes the same retry metadata schema as the HTTP catalog", async () => {
    const server = createMcpServer({} as TracerService, ["build:write"])
    const client = new Client({ name: "build-mcp-test", version: "1" })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "build_create_agent"
    )
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        requestKey: { type: "string" },
      },
    })

    await client.close()
    await server.close()
  })
})
