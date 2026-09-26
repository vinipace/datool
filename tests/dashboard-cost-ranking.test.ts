import { expect, test } from "bun:test"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import { traces, spans } from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  executeSemanticQuery,
  validateSemanticQuery,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"

const from = "2026-09-07T00:00:00Z"
const to = "2026-09-08T00:00:00Z"
const positiveCost = { member: "logs.spanCostUsd", operator: "gt", values: [0] }
const rankingQuery = {
  measures: ["logs.costUsd"],
  dimensions: ["logs.traceName"],
  filters: [positiveCost],
  timeDimensions: [{ dimension: "logs.startedAt", dateRange: [from, to] }],
  order: [
    ["logs.costUsd", "desc"],
    ["logs.traceName", "asc"],
  ],
  total: true,
}

test("cost ranking combines repeated names, excludes zero and unknown costs, and pages after aggregation", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        [
          { id: "a1", name: "Alpha", startedAt: "2026-09-06T23:00:00Z" },
          { id: "a2", name: "Alpha" },
          { id: "b", name: "Beta" },
          { id: "case", name: "alpha" },
          { id: "zero", name: "Zero" },
          { id: "unknown", name: "Unknown" },
        ].map((row) => ({
          operation: "workflow",
          status: "completed",
          startedAt: from,
          endedAt: to,
          attributesJson: '{"cost.usd":999}',
          ...row,
        }))
      )
    )
    const costSpan = (
      id: string,
      traceId: string,
      cost: number,
      extra = {}
    ) => ({
      id,
      traceId,
      name: id,
      kind: "llm",
      status: "completed",
      startedAt: from,
      attributesJson: JSON.stringify({ "cost.usd": cost }),
      ...extra,
    })
    await db.insert(spans).values(
      scopeRows(db, [
        costSpan("a1-paid", "a1", 2, { name: "Generate" }),
        costSpan("a2-paid", "a2", 3, { name: "Summarize" }),
        costSpan("b-paid", "b", 4, { name: "Generate" }),
        costSpan("case-paid", "case", 1, { name: "generate" }),
        costSpan("zero-paid", "zero", 0),
        costSpan("a-zero", "a2", 0),
        costSpan("a-partial", "a2", 500, {
          attributesJson: '{"cost.usd":500,"cost.status":"partial"}',
        }),
        costSpan("a-wrapper", "a2", 1000, { kind: "agent" }),
        costSpan("a-outside", "a2", 100, { startedAt: to }),
        costSpan("unknown-missing", "unknown", 0, { attributesJson: "{}" }),
        costSpan("unknown-negative", "unknown", -5),
        costSpan("unknown-invalid", "unknown", 0, {
          attributesJson: '{"cost.usd":"invalid"}',
        }),
      ])
    )
    const execute = (query: unknown) =>
      executeSemanticQuery(query, {
        catalog: semanticCatalog,
        requestId: "cost-ranking-test",
        snapshotRunner: createSemanticSnapshotRunner(db),
      })
    const widget = dashboardWidgetSchema.parse({
      id: "cost-by-trace-name",
      title: "Cost by trace name",
      type: "bar",
      width: 2,
      query: rankingQuery,
    })
    validateSemanticQuery(widget.query, semanticCatalog)
    const ranking = await execute(widget.query)
    expect(
      ranking.data.map((row) => [row["logs.traceName"], row["logs.costUsd"]])
    ).toEqual([
      ["Alpha", 5],
      ["Beta", 4],
      ["alpha", 1],
    ])
    const total = await execute({ ...rankingQuery, dimensions: [], order: [] })
    expect(total.data[0]["logs.costUsd"]).toBe(10)
    const page = await execute({ ...rankingQuery, limit: 1, offset: 1 })
    expect(page.data.map((row) => row["logs.traceName"])).toEqual(["Beta"])
    expect(page.meta.page.total).toBe(3)
    const filtered = await execute({
      ...rankingQuery,
      filters: [
        positiveCost,
        {
          member: "logs.traceName",
          operator: "equals",
          values: ["Alpha"],
        },
      ],
    })
    expect(filtered.data).toHaveLength(1)
    expect(filtered.data[0]["logs.costUsd"]).toBe(5)
    const combined = await execute({
      ...rankingQuery,
      dimensions: ["logs.trace", "logs.traceName"],
    })
    expect(combined.data).toHaveLength(4)
    expect(
      combined.data.find((row) => row["logs.trace"] === "Alpha · a1")?.[
        "logs.traceName"
      ]
    ).toBe("Alpha")
    const daily = await execute({
      ...rankingQuery,
      timeDimensions: [
        { ...rankingQuery.timeDimensions[0], granularity: "day" },
      ],
    })
    expect(daily.data[0]).toMatchObject({
      "logs.startedAt": "2026-09-07",
      "logs.traceName": "Alpha",
      "logs.costUsd": 5,
    })
    const empty = await execute({
      ...rankingQuery,
      filters: [
        positiveCost,
        {
          member: "logs.traceName",
          operator: "equals",
          values: ["Zero"],
        },
      ],
    })
    expect(empty.data).toEqual([])
    const spanQuery = {
      ...rankingQuery,
      dimensions: ["logs.spanName"],
      order: [
        ["logs.costUsd", "desc"],
        ["logs.spanName", "asc"],
      ],
    }
    const spanRanking = await execute(spanQuery)
    expect(
      spanRanking.data.map((row) => [row["logs.spanName"], row["logs.costUsd"]])
    ).toEqual([
      ["Generate", 6],
      ["Summarize", 3],
      ["generate", 1],
    ])
    const spanPage = await execute({ ...spanQuery, limit: 1, offset: 1 })
    expect(spanPage.data[0]["logs.spanName"]).toBe("Summarize")
    expect(spanPage.meta.page.total).toBe(3)
    const spanFilter = {
      member: "logs.spanName",
      operator: "equals",
      values: ["Generate"],
    }
    const spanTotal = await execute({
      ...spanQuery,
      dimensions: [],
      order: [],
      filters: [positiveCost, spanFilter],
    })
    expect(spanTotal.data[0]["logs.costUsd"]).toBe(6)
    for (const traceDimensions of [
      ["logs.traceName"],
      ["logs.trace"],
      ["logs.trace", "logs.traceName"],
    ]) {
      const combinedSpans = await execute({
        ...spanQuery,
        dimensions: [...traceDimensions, "logs.spanName"],
        filters: [positiveCost, spanFilter],
      })
      expect(combinedSpans.data).toHaveLength(2)
      expect(combinedSpans.data[0]).toMatchObject({
        "logs.spanName": "Generate",
        "logs.costUsd": 4,
        ...Object.fromEntries(
          traceDimensions.map((dimension) => [
            dimension,
            dimension === "logs.trace" ? "Beta · b" : "Beta",
          ])
        ),
      })
    }
    const spanDaily = await execute({
      ...spanQuery,
      timeDimensions: [
        { ...rankingQuery.timeDimensions[0], granularity: "day" },
      ],
    })
    expect(spanDaily.data[0]).toMatchObject({
      "logs.startedAt": "2026-09-07",
      "logs.spanName": "Generate",
      "logs.costUsd": 6,
    })
    const emptySpans = await execute({
      ...spanQuery,
      filters: [positiveCost, { ...spanFilter, values: ["zero-paid"] }],
    })
    expect(emptySpans.data).toEqual([])
    // Span names must never silently partition or filter parent-trace latency.
    for (const selection of [
      { dimensions: ["logs.spanName"], filters: [] },
      { dimensions: [], filters: [{ or: [spanFilter] }] },
    ]) {
      const spanLatencyError = await execute({
        ...spanQuery,
        ...selection,
        measures: ["logs.meanLatencyMs"],
        order: [],
      }).then(
        () => null,
        (error: Error) => error.message
      )
      expect(spanLatencyError).toContain(
        "Span-level grouping and filters cannot be used with trace latency"
      )
    }
    const latency = await execute({
      ...rankingQuery,
      measures: ["logs.meanLatencyMs"],
      filters: [],
      order: [],
    })
    expect(
      latency.data.find((row) => row["logs.traceName"] === "Alpha")?.[
        "logs.meanLatencyMs"
      ]
    ).toBe(86400000)
    const latencyError = await execute({
      ...rankingQuery,
      measures: ["logs.meanLatencyMs"],
      order: [],
    }).then(
      () => null,
      (error: Error) => error.message
    )
    expect(latencyError).toContain(
      "Span-level grouping and filters cannot be used with trace latency"
    )
  } finally {
    await closeTracerFixture(db)
  }
})
