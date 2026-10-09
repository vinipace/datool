import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { createMcpServer } from "../src/server/mcp/server"
import { tracerEffect } from "../src/server/tracer/effect"
import type { TracerService } from "../src/server/tracer/service"

test("MCP discovers and forwards review defaults and item-only criteria changes", async () => {
  const writes: { kind: string; input: unknown }[] = []
  const service = {
    reviews: {
      create: (input: unknown) => tracerEffect(async () => {
        writes.push({ kind: "create", input })
        return { id: "session", revision: 1 }
      }),
      update: (id: string, input: unknown) => tracerEffect(async () => {
        writes.push({ kind: "update", input: { id, ...(input as object) } })
        return { id, revision: 2 }
      }),
      record: (sessionId: string, itemId: string, input: unknown) => tracerEffect(async () => {
        writes.push({ kind: "record", input: { sessionId, itemId, ...(input as object) } })
        return { id: itemId, revision: 1 }
      }),
    },
  } as unknown as TracerService
  const server = createMcpServer(service, ["reviews:read", "reviews:write", "traces:read"])
  const client = new Client({ name: "review-controls", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a)
    await client.connect(b)
    const { tools } = await client.listTools()
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    const calls = [
      ["create_review_session", { name: "Evidence review", traceIds: ["trace"], defaultObjectViewId: "view" }],
      ["update_review_session", { id: "session", expectedRevision: 1, defaultObjectViewId: null }],
      ["record_review", { sessionId: "session", itemId: "item", expectedRevision: 0, replaceCriteria: true, scores: [] }],
      ["record_review", { sessionId: "session", itemId: "item", expectedRevision: 1, notes: "Evidence missing." }],
    ] as const
    for (const [name, input] of calls) {
      const advertised = tools.find(tool => tool.name === name)!
      expect(ajv.compile(advertised.inputSchema)(input)).toBe(true)
      const result = await client.callTool({ name, arguments: input })
      expect(result.isError).not.toBe(true)
      expect(writes.at(-1)?.input).toMatchObject(input)
    }
    expect(Object.hasOwn(writes.at(-1)!.input as object, "scores")).toBe(false)
    expect(Object.hasOwn(writes.at(-1)!.input as object, "replaceCriteria")).toBe(false)
    for (const input of [
      { sessionId: "session", itemId: "item", expectedRevision: 0, replaceCriteria: true, notes: "No selection" },
      { sessionId: "session", itemId: "item", expectedRevision: 0 },
    ]) {
      expect((await client.callTool({ name: "record_review", arguments: input })).isError).toBe(true)
    }
    expect(writes).toHaveLength(calls.length)
  } finally {
    await client.close()
    await server.close()
  }
})
