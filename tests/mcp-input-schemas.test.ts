import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { semanticQuerySchema } from "../src/lib/semantic/query"
import { agentOperations } from "../src/server/mcp/operations"
import { createMcpServer } from "../src/server/mcp/server"
import type { TracerService } from "../src/server/tracer/service"

const condition = {
  member: "traces.status",
  operator: "equals",
  values: ["completed"],
}
const nested = { and: [{ or: [condition] }] }

function inputs(
  filters: unknown[],
  queryOverrides: Record<string, unknown> = {}
) {
  const query = {
    measures: ["traces.count"],
    filters,
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
      },
    ],
    order: [["traces.count", "desc"]],
    ...queryOverrides,
  }
  const config = {
    schemaVersion: 1,
    name: "Filtered traces",
    description: "",
    widgets: [{ id: "count", title: "Count", type: "metric", width: 1, query }],
  }
  const document = {
    name: "Filtered traces",
    mdx: '<Metric source="traces" />',
    sources: { traces: { query } },
  }
  return {
    query_metrics: { query },
    batch_metrics: { queries: [query] },
    create_dashboard: { config },
    update_dashboard: { id: "dashboard", expectedRevision: 1, config },
    create_report: {
      ...document,
      creationKey: "00000000-0000-4000-8000-000000000001",
    },
    validate_report: { document },
    update_report: { number: 1, revision: 1, document },
  }
}

test("MCP publishes 2020-12 tuple schemas that clients can load without losing positional validation", async () => {
  // Discovery must not call a service or require a database.
  const server = createMcpServer({} as TracerService, [
    "metrics:read",
    "dashboards:read",
    "dashboards:write",
  ])
  const client = new Client({ name: "schema-contract", version: "1" })
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    const valid = inputs([nested])
    const invalid = [
      inputs([nested], { order: [["desc", "traces.count"]] }),
      inputs([nested], { order: [["traces.count", "desc", "extra"]] }),
      inputs([nested], {
        timeDimensions: [
          {
            dimension: "traces.startedAt",
            dateRange: ["2026-09-01T00:00:00Z"],
          },
        ],
      }),
    ]
    for (const name of Object.keys(valid) as (keyof typeof valid)[]) {
      const tool = tools.find((tool) => tool.name === name)
      assert(tool, name)
      assert.equal(
        tool.inputSchema.$schema,
        "https://json-schema.org/draft/2020-12/schema",
        name
      )
      const validate = ajv.compile(tool.inputSchema)
      assert.equal(
        validate(valid[name]),
        true,
        `${name}: nested filters and tuples`
      )
      for (const input of invalid)
        assert.equal(validate(input[name]), false, name)
    }
  } finally {
    await client.close()
    await server.close()
  }
})

test("shared operation validation preserves filter limits and semantic checks", () => {
  const atLimit = [{ and: Array.from({ length: 24 }, () => condition) }]
  for (const filters of [[condition], [nested], atLimit]) {
    for (const [name, input] of Object.entries(inputs(filters))) {
      const operation = agentOperations.find(
        (operation) => operation.name === name
      )!
      assert.equal(operation.schema.safeParse(input).success, true, name)
    }
  }
  const invalidFilters = [
    [{ or: [nested] }],
    [{ and: Array.from({ length: 25 }, () => condition) }],
    [{ and: [] }],
    [{ or: [] }],
    [{ ...condition, or: [condition] }],
    [{ member: "traces.status", operator: "equals" }],
    [{ ...condition, operator: "set" }],
    [{ ...condition, path: ["__proto__"] }],
    [{ ...condition, values: [Infinity] }],
    [{ ...condition, member: "spans.status" }],
  ]
  for (const filters of invalidFilters) {
    for (const [name, input] of Object.entries(inputs(filters))) {
      const operation = agentOperations.find(
        (operation) => operation.name === name
      )!
      assert.equal(operation.schema.safeParse(input).success, false, name)
    }
  }
  expect(
    semanticQuerySchema.parse({
      measures: ["traces.count"],
      filters: [{ or: [{ member: "traces.status", operator: "set" }] }],
    }).filters
  ).toEqual([{ or: [{ member: "traces.status", operator: "set" }] }])
})
