import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createMcpServer } from "@/src/server/mcp/server"
import type { TracerService } from "@/src/server/tracer/service"
import { buildOperationCatalog } from "@/src/server/build/bootstrap"

describe("Build MCP transport", () => {
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
