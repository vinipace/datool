import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SemanticCatalogMetadata } from "../src/lib/semantic/catalog"
import type { SemanticResult } from "../src/lib/semantic/result"
import { semanticQuerySchema } from "../src/lib/semantic/query"
import { newDashboardWidget } from "../src/lib/tracer/dashboards"
import { createMcpServer } from "../src/server/mcp/server"
import { semanticCatalog } from "../src/server/metrics/registry"
import { acquireRead } from "../src/server/semantic/read-budget"
import type { TracerDatabase } from "../src/server/tracer/db"
import { runTracerEffect } from "../src/server/tracer/effect"
import { scoreImports, scores, spans } from "../src/server/tracer/schema"
import { TracerService } from "../src/server/tracer/service"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

let db: TracerDatabase
let client: Client
let service: TracerService
let project: string
let dateRange: [string, string]

async function fixture(name: string) {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/agent-operations/${name}.json`, import.meta.url),
      "utf8"
    )
  )
}
function inWindow(input: unknown) {
  const query = semanticQuerySchema.parse(input)
  return {
    ...query,
    timeDimensions: query.timeDimensions.map((time) => ({
      ...time,
      dateRange,
    })),
  }
}
async function call<T>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  return (result.structuredContent as { data: T }).data
}

beforeAll(async () => {
  db = await createTracerFixture()
  service = new TracerService(db)
  const facts = await seedEvalAttributionFacts(db, 2, 2)
  project = facts.project
  dateRange = [
    new Date(facts.now.getTime() - 86400000).toISOString(),
    new Date(facts.now.getTime() + 86400000).toISOString(),
  ]
  await db.insert(spans).values(
    scopeRows(
      db,
      [1, 0, null].map((cost, i) => ({
        id: `mcp-span-${i}`,
        traceId: facts.trace.id,
        name: "LLM",
        kind: "llm",
        status: "completed",
        startedAt: facts.now.toISOString(),
        endedAt: new Date(facts.now.getTime() + 100).toISOString(),
        attributesJson: JSON.stringify({
          "gen_ai.response.model": `Model ${i}`,
          "cost.usd": cost,
        }),
      }))
    )
  )
  // An imported rating is not another evaluation execution; its scale differs.
  await db.insert(scoreImports).values(
    scopeRows(db, {
      id: "import-rating",
      payload: {},
      status: "imported",
      createdAt: facts.now.toISOString(),
      updatedAt: facts.now.toISOString(),
    })
  )
  await db.insert(scores).values(
    scopeRows(db, {
      id: "imported-rating",
      traceId: facts.trace.id,
      importId: "import-rating",
      name: "Other criterion",
      value: 80,
      status: "ok",
      createdAt: facts.now.toISOString(),
      external: {
        name: "Other criterion",
        timestamp: facts.now.toISOString(),
        target: { type: "trace", id: facts.trace.id },
        data: { type: "numeric", value: 80 },
        source: {
          provider: "fixture",
          instance: "local",
          projectId: project,
          id: "import-rating",
        },
      },
    })
  )
  client = new Client({ name: "analytics-contract-test", version: "1" })
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair()
  await createMcpServer(service, ["metrics:read", "dashboards:read"]).connect(
    serverTransport
  )
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client?.close()
  if (db) await closeTracerFixture(db)
})

test("MCP discovers the current sources, capabilities and legacy meanings and executes the skill examples", async () => {
  const catalog = await call<SemanticCatalogMetadata>("get_metrics_metadata")
  expect(catalog).toEqual(semanticCatalog.metadata())
  expect(
    catalog.models
      .filter((m) => m.source?.visibility === "primary")
      .sort((a, b) => a.source!.order! - b.source!.order!)
      .map((m) => [m.name, m.source!.title])
  ).toEqual([
    ["traces", "Traces"],
    ["spans", "Spans"],
    ["evalRuns", "Evaluation Runs"],
    ["evalResults", "Evaluation Results"],
    ["scoreValues", "Scores"],
    ["evalClassification", "Classification"],
    ["evalComparison", "Paired evaluations"],
  ])
  expect(catalog.models.find((m) => m.name === "scores")?.source).toMatchObject(
    { visibility: "legacy", replacement: "evalResults" }
  )
  const ratings = catalog.models.find((m) => m.name === "scoreValues")!
  expect(
    ratings.members.find((m) => m.name === "scoreValues.meanValue")
  ).toMatchObject({ requiresDefinition: true })
  expect(
    ratings.members.find((m) => m.name === "scoreValues.metadata")
  ).toMatchObject({ groupable: false, filterValueType: "json" })
  expect(ratings.source?.unavailable?.length).toBeGreaterThan(0)

  const input = await fixture("five-source-counts")
  const results = await call<SemanticResult[]>("batch_metrics", {
    queries: input.queries.map(inWindow),
  })
  expect(
    results.map((result) => result.data[0][result.query.measures[0]])
  ).toEqual([1, 3, 2, 4, 5])
  expect(new Set(results.map((result) => result.meta.asOf)).size).toBe(1)
  expect(
    results.map((result) => result.query.timeDimensions[0].dimension)
  ).toEqual([
    "traces.startedAt",
    "spans.startedAt",
    "evalRuns.createdAt",
    "evalResults.completedAt",
    "scoreValues.recordedAt",
  ])
  const costs = await call<SemanticResult>("query_metrics", {
    query: inWindow((await fixture("spans-cost-by-model")).query),
  })
  expect(
    Object.fromEntries(
      costs.data.map((row) => [row["spans.model"], row["spans.costUsd"]])
    )
  ).toEqual({ "Model 0": 1, "Model 1": 0, "Model 2": null })
  const legacy = await call<SemanticResult>("query_metrics", {
    query: inWindow({
      measures: ["scores.executionCount"],
      timeDimensions: [{ dimension: "scores.completedAt", dateRange }],
    }),
  })
  expect(legacy.data[0]["scores.executionCount"]).toBe(4)
  expect(
    (await client.listTools()).tools.some(
      (tool) => tool.name === "create_dashboard"
    )
  ).toBe(false)
})

test("MCP rejects mixed score averages and accepts the definition-grouped skill example", async () => {
  const query = inWindow((await fixture("scores-by-definition")).query)
  const invalid = await client.callTool({
    name: "query_metrics",
    arguments: { query: { ...query, dimensions: [] } },
  })
  expect(invalid.isError).toBe(true)
  const content = invalid.content as { type: string; text: string }[]
  expect(content[0].type).toBe("text")
  expect(JSON.parse(content[0].text).code).toBe("VALIDATION_ERROR")
  expect(content[0].text).toContain("different definitions or scales")
  const grouped = await call<SemanticResult>("query_metrics", { query })
  expect(grouped.data).toHaveLength(2)
  expect(
    grouped.data.reduce(
      (total, row) => total + Number(row["scoreValues.count"]),
      0
    )
  ).toBe(5)
  expect(
    grouped.data
      .map((row) => Math.round(Number(row["scoreValues.meanValue"]) * 100))
      .sort((a, b) => a - b)
  ).toEqual([15, 8000])
})

test("MCP returns actionable READ_BUSY details and recovers after admission is released", async () => {
  const releases = [
    acquireRead(project, "analytics"),
    acquireRead(project, "analytics"),
  ]
  const query = inWindow((await fixture("trace-count")).query)
  try {
    const result = await client.callTool({
      name: "query_metrics",
      arguments: { query },
    })
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    expect(content[0].type).toBe("text")
    expect(JSON.parse(content[0].text).code).toBe("READ_BUSY")
    expect(JSON.parse(content[0].text).details).toEqual({
      retryAfterSeconds: 1,
    })
  } finally {
    releases.forEach((release) => release())
  }
  expect(
    (await call<SemanticResult>("query_metrics", { query })).data[0][
      "traces.count"
    ]
  ).toBe(1)
}, 10000)

test("dashboard previews preserve saved windows and use separate snapshots beyond 40 expanded queries", async () => {
  const model = semanticCatalog
    .metadata()
    .models.find((m) => m.name === "traces")!
  const dashboard = await runTracerEffect(
    service.dashboards.create({
      schemaVersion: 1,
      name: "Multi-batch preview",
      description: "Snapshot contract",
      widgets: Array.from({ length: 11 }, (_, i) => ({
        ...newDashboardWidget(model),
        id: `widget-${i}`,
        query: inWindow({
          measures: ["traces.count"],
          timeDimensions: [{ dimension: "traces.startedAt", dateRange }],
        }),
        groups: [
          {
            type: "workflow" as const,
            name: "Fixture",
            versions: ["v1", "v2", "v3"],
          },
        ],
        compare: { type: "workflow" as const, name: "Fixture" },
      })),
    })
  )
  const preview = await call<{
    results: SemanticResult[]
    comparisons: { cohorts: { result: SemanticResult }[] }[]
  }>("preview_dashboard", { id: dashboard.id })
  expect(preview.results).toHaveLength(11)
  expect(preview.comparisons).toHaveLength(11)
  const results = preview.results.flatMap((result, i) => [
    result,
    ...preview.comparisons[i].cohorts.map((cohort) => cohort.result),
  ])
  expect(results).toHaveLength(44)
  expect(
    new Set(results.slice(0, 40).map((result) => result.meta.asOf)).size
  ).toBe(1)
  expect(
    new Set(results.slice(40).map((result) => result.meta.asOf)).size
  ).toBe(1)
  expect(results[40].meta.asOf).not.toBe(results[0].meta.asOf)
  expect(
    results.every(
      (result) =>
        JSON.stringify(result.query.timeDimensions[0].dateRange) ===
        JSON.stringify(dateRange)
    )
  ).toBe(true)
}, 15000)
