import { scopeRows } from "./helpers/tracer-fixture"
import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { traces, spans } from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticQuery } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import { scopedWidget, dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { newDashboardWidget } from "@/src/lib/tracer/dashboards"

const from = "2026-09-05T00:00:00Z",
  to = "2026-09-08T00:00:00Z"
test("shared dashboard filters narrow spans, tokens, costs and latency before aggregation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datool-dashboard-logs-"))
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(scopeRows(db, [
      {
        id: "a",
        name: "Alpha",
        operation: "chat",
        status: "completed",
        startedAt: "2026-09-07T00:00:00Z",
        endedAt: "2026-09-07T00:00:01Z",
        attributesJson: JSON.stringify({ "cost.usd": 100, env: "prod" }),
      },
      {
        id: "b",
        name: "Beta",
        operation: "chat",
        status: "errored",
        startedAt: "2026-09-06T00:00:00Z",
        endedAt: "2026-09-06T00:00:03Z",
        attributesJson: JSON.stringify({ env: "dev" }),
      },
    ]))
    await db.insert(spans).values(
      scopeRows(db, [
        {
          id: "a-llm",
          traceId: "a",
          kind: "llm",
          attributesJson: JSON.stringify({
            "usage.input_tokens": 100,
            "usage.output_tokens": 20,
            "usage.cache_read_tokens": 30,
            "cost.usd": 0.4,
            "cost.breakdown": {
              inputUSD: 0.2,
              outputUSD: 0.1,
              cacheReadsUSD: 0.1,
            },
            "ttft.ms": 250,
          }),
        },
        { id: "a-tool", traceId: "a", kind: "tool", attributesJson: "{}" },
        {
          id: "a-wrapper",
          traceId: "a",
          kind: "agent",
          attributesJson: JSON.stringify({
            "cost.usd": 100,
            "usage.input_tokens": 10000,
          }),
        },
        {
          id: "b-llm",
          traceId: "b",
          kind: "llm",
          attributesJson: JSON.stringify({
            "usage.input_tokens": 40,
            "usage.output_tokens": 10,
            "cost.usd": 0.3,
          }),
        },
      ].map((row) => ({
        ...row,
        name: row.id,
        status: "completed",
        startedAt:
          row.traceId === "a" ? "2026-09-07T00:00:00Z" : "2026-09-06T00:00:00Z",
        endedAt: "2026-09-07T00:00:01Z",
      })))
    )
    const measures = [
      "spanCount",
      "llmCount",
      "toolCount",
      "otherCount",
      "tokenCount",
      "inputTokens",
      "outputTokens",
      "cacheTokens",
      "costUsd",
      "inputCostUsd",
      "outputCostUsd",
      "cacheCostUsd",
      "meanLatencyMs",
      "p95LatencyMs",
      "meanTtftMs",
    ].map((m) => `logs.${m}`)
    const query = {
      measures,
      timeDimensions: [{ dimension: "logs.startedAt", dateRange: [from, to] }],
      total: true,
    }
    const execute = (input: unknown) =>
      executeSemanticQuery(input, {
        catalog: semanticCatalog,
        requestId: "logs-test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      })
    const all = await execute(query)
    expect(all.data[0]["logs.spanCount"]).toBe(4)
    expect(Number(Number(all.data[0]["logs.costUsd"]).toFixed(8))).toBe(0.7)
    expect(all.data[0]["logs.meanLatencyMs"]).toBe(2000)
    const filtered = await execute({
      ...query,
      filters: traceExpressionFilters(
        "attributes.env = 'prod'",
        "logs",
        Date.parse(to)
      ),
    })
    expect(filtered.data[0]).toMatchObject({
      "logs.spanCount": 3,
      "logs.llmCount": 1,
      "logs.toolCount": 1,
      "logs.otherCount": 1,
      "logs.tokenCount": 120,
      "logs.inputTokens": 70,
      "logs.outputTokens": 20,
      "logs.cacheTokens": 30,
      "logs.costUsd": 0.4,
      "logs.inputCostUsd": 0.2,
      "logs.outputCostUsd": 0.1,
      "logs.cacheCostUsd": 0.1,
      "logs.meanLatencyMs": 1000,
      "logs.p95LatencyMs": 1000,
      "logs.meanTtftMs": 250,
    })
    const noTtft = await execute({
      ...query,
      filters: traceExpressionFilters("name = 'Beta'", "logs", Date.parse(to)),
    })
    expect(noTtft.data[0]["logs.meanTtftMs"]).toBeNull()
    const fullText = await execute({
      ...query,
      filters: traceExpressionFilters('"PROD" status = completed', "logs", Date.parse(to)),
    })
    expect(fullText.data).toEqual(filtered.data)
    const noMatches = await execute({
      ...query,
      filters: traceExpressionFilters(
        "name = 'Absent'",
        "logs",
        Date.parse(to)
      ),
    })
    expect(noMatches.data[0]["logs.spanCount"]).toBe(0)
    expect(noMatches.data[0]["logs.costUsd"]).toBeNull()
    const narrowed = await execute({
      ...query,
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          dateRange: ["2026-09-07T00:00:00Z", to],
        },
      ],
    })
    expect(narrowed.data[0]["logs.spanCount"]).toBe(3)
    const cost = await execute({
      measures: ["traces.reportedCostUsd"],
      dimensions: ["traces.trace"],
      timeDimensions: [
        { dimension: "traces.startedAt", dateRange: [from, to] },
      ],
      filters: traceExpressionFilters(
        "name = 'Beta'",
        "traces",
        Date.parse(to)
      ),
    })
    expect(cost.data).toHaveLength(1)
    expect(cost.data[0]["traces.trace"]).toBe("Beta · b")
  } finally {
    await closeTracerFixture(db)
    await rm(dir, { recursive: true, force: true })
  }
})

test("scope replaces date windows and combines shared filters with saved widget filters", () => {
  const model = semanticCatalog
    .metadata()
    .models.find((m) => m.name === "traces")!
  const widget = newDashboardWidget(model)
  widget.query.filters = [
    { member: "traces.status", operator: "equals", values: ["completed"] },
  ]
  const result = scopedWidget(widget, {
    filter: "name = 'Alpha'",
    from,
    to,
    timezone: "UTC",
  })
  expect(result.query.timeDimensions[0].dateRange).toEqual([from, to])
  expect(result.query.filters).toHaveLength(2)
  expect(widget.query.filters).toHaveLength(1)
})


test("dashboard date clauses control the semantic window without filtering parent trace age", () => {
  const now = Date.parse("2026-09-08T12:00:00Z")
  const scope = dashboardFilterScope("startedAt >= -7d name = Alpha", now, "UTC")
  expect(scope.from).toBe("2026-09-01T12:00:00.000Z")
  expect(scope.to).toBe("2026-09-08T12:00:00.000Z")
  expect(scope.filter).toBe("name = Alpha")
  const range = dashboardFilterScope("startedAt >= '2026-09-01T00:00:00Z' startedAt < '2026-09-03T00:00:00Z'", now, "UTC")
  expect(range.from).toBe("2026-09-01T00:00:00.000Z")
  expect(range.to).toBe("2026-09-03T00:00:00.000Z")
  expect(range.filter).toBe("")
  expect(() => dashboardFilterScope("startedAt >= -91d", now, "UTC")).toThrow("90 days")
  expect(() => dashboardFilterScope("startedAt >= -1d startedAt < -2d", now, "UTC")).toThrow("non-empty")
})
