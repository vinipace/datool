import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"
import { spans, traces } from "@/src/server/tracer/schema"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  executeSemanticBatch,
  executeSemanticQuery,
} from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { dashboardTemplates } from "@/src/lib/tracer/dashboard-templates"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { groupedTimeChart } from "@/src/lib/tracer/dashboard-time-series"
import { comparisonTimeChart } from "@/components/tracer/dashboard-comparison"
import { dashboardMetricHistory } from "@/src/lib/tracer/dashboard-metric-history"
import { semanticResultForQuery } from "@/.storybook/scenarios/dashboards/fixtures"

const currentWidget = dashboardTemplates
  .find((template) => template.id === "cost-and-usage")!
  .create(new Date("2026-09-11T00:00:00Z"))
  .widgets.find((widget) => widget.id === "cost-by-model")!

const widget = dashboardWidgetSchema.parse(
  JSON.parse(JSON.stringify(currentWidget).replaceAll("spans.", "logs."))
)

test("model cost groups persisted LLM quotes by day, preserves totals, and filters model aliases", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(db, {
        id: "model-cost",
        name: "Model cost",
        operation: "workflow",
        status: "completed",
        startedAt: "2026-09-01T00:00:00Z",
        attributesJson: '{"cost.usd":999}',
      })
    )
    const samples = [
      {
        "gen_ai.response.model": "alpha",
        "gen_ai.request.model": "requested",
        "cost.usd": 2,
      },
      { "ai.response.model": "alpha", "cost.usd": 3 },
      { "gen_ai.request.model": "beta", "cost.usd": 4 },
      { "ai.model.id": "beta", "cost.usd": 0 },
      { model: "alpha", "cost.usd": 1 },
      {
        "gen_ai.response.model": 123,
        "ai.response.model": " \t",
        model: "beta",
        "cost.usd": 6,
      },
      { "cost.usd": 7 },
      { model: "alpha", "cost.usd": 800, "cost.status": "partial" },
      { model: "alpha", "cost.usd": 900 },
      { model: "alpha", "cost.usd": 1000 },
      { model: "beta", "cost.usd": -10 },
    ]
    await db.insert(spans).values(
      scopeRows(
        db,
        samples.map((attributes, index) => ({
          id: `model-${index}`,
          traceId: "model-cost",
          name: "Generate",
          kind: index === 8 ? "agent" : "llm",
          status: "completed",
          startedAt:
            index === 9
              ? "2026-09-11T00:00:00Z"
              : index === 1
                ? "2026-09-09T01:00:00Z"
                : "2026-09-08T01:00:00Z",
          attributesJson: JSON.stringify(attributes),
        }))
      )
    )
    const context = {
      catalog: semanticCatalog,
      requestId: "model-cost",
      snapshotRunner: createSemanticSnapshotRunner(db),
    }
    const plan = dashboardQueryPlan([widget], {})
    const [daily, summary] = await executeSemanticBatch(
      { queries: plan.batches[0] },
      context
    )
    expect(summary.query.dimensions).toEqual(["logs.model"])
    expect(
      summary.data.map((row) => [row["logs.model"], row["logs.costUsd"]]).sort()
    ).toEqual(
      [
        ["alpha", 6],
        ["beta", 10],
        [null, 7],
      ].sort()
    )
    expect(
      daily.data.find(
        (row) =>
          row["logs.model"] === "alpha" &&
          row["logs.startedAt"] === "2026-09-08"
      )?.["logs.costUsd"]
    ).toBe(3)
    expect(daily.meta.asOf).toBe(summary.meta.asOf)
    const total = await executeSemanticQuery(
      { ...summary.query, dimensions: [], order: [] },
      context
    )
    expect(total.data[0]["logs.costUsd"]).toBe(23)
    expect(
      daily.data.reduce((sum, row) => sum + Number(row["logs.costUsd"]), 0)
    ).toBe(23)
    const filtered = await executeSemanticQuery(
      {
        ...widget.query,
        filters: [
          ...widget.query.filters,
          { member: "logs.model", operator: "equals", values: ["alpha"] },
        ],
      },
      context
    )
    expect(filtered.data).toHaveLength(2)
    expect(filtered.data.every((row) => row["logs.model"] === "alpha")).toBe(
      true
    )
    await rejects(
      executeSemanticQuery(
        { ...widget.query, measures: ["logs.meanLatencyMs"] },
        context
      ),
      /Span-level grouping/
    )
    const chart = groupedTimeChart(widget, daily, summary)
    const keys = Object.fromEntries(
      Object.entries(chart.result.annotation.measures).map(
        ([key, annotation]) => [annotation.title, key]
      )
    )
    expect(chart.summary?.data[0][keys.alpha]).toBe(6)
    expect(chart.summary?.data[0][keys["Not recorded"]]).toBe(7)
    expect(
      chart.result.data.find((row) => row["logs.startedAt"] === "2026-09-09")?.[
        keys.beta
      ]
    ).toBeNull()
  } finally {
    await closeTracerFixture(db)
  }
})

test("grouped time series retain zeroes, gaps, typed identities, and per-cohort totals", () => {
  const result = semanticResultForQuery(widget.query)
  result.data = [
    {
      "logs.startedAt": "2026-09-08",
      "logs.model": "model.with.dots",
      "logs.costUsd": 0,
    },
    {
      "logs.startedAt": "2026-09-08",
      "logs.model": "Not recorded",
      "logs.costUsd": 2,
    },
    { "logs.startedAt": "2026-09-10", "logs.model": null, "logs.costUsd": 3 },
    {
      "logs.startedAt": "2026-09-10",
      "logs.model": "model.with.dots",
      "logs.costUsd": 4,
    },
  ]
  result.meta.page.total = result.data.length
  const summary = {
    ...result,
    data: [
      {
        "logs.startedAt": null,
        "logs.model": "model.with.dots",
        "logs.costUsd": 4,
      },
      {
        "logs.startedAt": null,
        "logs.model": "Not recorded",
        "logs.costUsd": 2,
      },
      { "logs.startedAt": null, "logs.model": null, "logs.costUsd": 3 },
    ],
  }
  const chart = groupedTimeChart(widget, result, summary)
  expect(chart.widget.series).toHaveLength(3)
  expect(chart.result.data).toHaveLength(2)
  expect(chart.result.meta.page.total).toBe(2)
  const key = Object.keys(chart.result.annotation.measures).find(
    (key) => chart.result.annotation.measures[key].title === "model.with.dots"
  )!
  expect(chart.result.data[0][key]).toBe(0)
  expect(
    dashboardMetricHistory(chart.result, key).find(
      (row) => row.date === "2026-09-09"
    )?.value
  ).toBeNull()
  expect(
    groupedTimeChart(
      widget,
      { ...result, query: { ...result.query, offset: 1 } },
      summary
    ).result.meta.page.total
  ).toBeUndefined()
  const comparison = comparisonTimeChart(widget, [
    { label: "v1", result, summary, offsetKey: "0" },
    { label: "v2", result, summary, offsetKey: "1" },
  ])
  expect(comparison.widget.series).toHaveLength(6)
  expect(comparison.result.query.dimensions).toEqual([])
  expect(Object.values(comparison.summary!.data[0]).sort()).toEqual([
    2, 2, 3, 3, 4, 4,
  ])
  expect(
    dashboardWidgetSchema.safeParse({
      ...widget,
      query: { ...widget.query, dimensions: ["logs.model", "logs.spanName"] },
    }).success
  ).toBe(false)
})
