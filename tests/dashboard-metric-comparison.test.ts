import { expect, test } from "bun:test"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { dashboardMetricHistory } from "@/src/lib/tracer/dashboard-metric-history"
import {
  defaultMetricTrendDirection,
  metricDelta,
  previousPeriodQuery,
} from "@/src/lib/tracer/dashboard-metric-comparison"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticBatch } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import { traces } from "@/src/server/tracer/schema"
import {
  createTracerFixture,
  closeTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

const widget = dashboardWidgetSchema.parse({
  id: "failures",
  title: "Failures",
  type: "metric",
  width: 1,
  query: {
    measures: ["traces.erroredCount"],
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: ["2026-09-06T00:00:00Z", "2026-09-13T00:00:00Z"],
      },
    ],
    filters: [
      { member: "traces.operation", operator: "equals", values: ["chat"] },
    ],
  },
})

test("previous period is adjacent and equal duration, including a DST range, without changing filters", () => {
  const query = {
    ...widget.query,
    timezone: "America/New_York",
    having: [
      { member: "traces.erroredCount", operator: "gt" as const, values: [2] },
    ],
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: [
          "2026-03-07T00:00:00-05:00",
          "2026-03-09T00:00:00-04:00",
        ] as [string, string],
      },
    ],
  }
  const previous = previousPeriodQuery(query)
  const [start, end] = query.timeDimensions[0].dateRange.map(Date.parse)
  const [priorStart, priorEnd] = previous.timeDimensions[0].dateRange.map(
    Date.parse
  )
  expect(priorEnd).toBe(start)
  expect(priorEnd - priorStart).toBe(end - start)
  expect(end - start).toBe(47 * 3600 * 1000)
  expect({ ...previous, timeDimensions: query.timeDimensions }).toEqual(query)
  expect(query.timeDimensions[0].dateRange[0]).toBe("2026-03-07T00:00:00-05:00")
})

test("metric totals, comparisons, daily bars and every version share a batch within the 40 query limit", () => {
  const compared = {
    ...widget,
    groups: [
      { type: "agent" as const, name: "Research", versions: ["v1", "v2"] },
    ],
    compare: { type: "agent" as const, name: "Research" },
  }
  const plan = dashboardQueryPlan(
    Array.from({ length: 21 }, (_, i) => ({ ...compared, id: `tile-${i}` })),
    {}
  )
  expect(plan.batches.map((batch) => batch.length)).toEqual([36, 36, 36, 18])
  const queries = plan.batches.flat()
  const queryBatches = plan.batches.flatMap((batch, index) =>
    batch.map(() => index)
  )
  for (const position of plan.positions) {
    const batchNumbers = new Set<number>()
    for (const cohort of position.cohorts) {
      expect(cohort.previous).toBe(cohort.result + 1)
      expect(cohort.history).toBe(cohort.result + 2)
      expect(cohort.summary).toBeNull()
      const current = queries[cohort.result]
      expect(queries[cohort.previous!]).toEqual(previousPeriodQuery(current))
      expect(JSON.stringify(current.filters)).toContain(
        cohort.label!.endsWith("v1") ? "v1" : "v2"
      )
      batchNumbers.add(queryBatches[cohort.result])
      batchNumbers.add(queryBatches[cohort.previous!])
      batchNumbers.add(queryBatches[cohort.history!])
    }
    expect(batchNumbers.size).toBe(1)
  }
})

test("daily bars retain the range and cohort without scalar pagination or whole-period thresholds", () => {
  const scalar = {
    ...widget,
    query: {
      ...widget.query,
      timezone: "America/New_York",
      limit: 1,
      having: [
        { member: "traces.erroredCount", operator: "gt" as const, values: [2] },
      ],
    },
  }
  const plan = dashboardQueryPlan([scalar], { "failures:0": 10 })
  const cohort = plan.positions[0].cohorts[0]
  const history = plan.batches.flat()[cohort.history!]
  expect(history).toEqual({
    ...scalar.query,
    total: true,
    having: [],
    timeDimensions: scalar.query.timeDimensions.map((time) => ({
      ...time,
      granularity: "day",
    })),
    limit: 100,
    offset: 0,
    order: [["traces.startedAt", "asc"]],
  })
  expect(scalar.query.limit).toBe(1)
  expect(scalar.query.having.length).toBe(1)
})

test("delta direction follows metric meaning; zero and missing baselines never imply infinity", () => {
  expect(metricDelta(12, 24, "decrease")).toMatchObject({
    available: true,
    relative: -0.5,
    trend: "down",
    tone: "positive",
  })
  expect(metricDelta(30, 24, "decrease")).toMatchObject({
    relative: 0.25,
    trend: "up",
    tone: "negative",
  })
  expect(metricDelta(30, 24, "increase")).toMatchObject({ tone: "positive" })
  expect(metricDelta(12, 24, "increase")).toMatchObject({ tone: "negative" })
  expect(metricDelta(5, 0, "decrease")).toMatchObject({
    absolute: 5,
    relative: null,
    tone: "negative",
  })
  expect(metricDelta(0, 5, "decrease")).toMatchObject({
    relative: -1,
    tone: "positive",
  })
  expect(metricDelta(0, 0, "decrease")).toMatchObject({
    trend: "flat",
    tone: "neutral",
  })
  expect(metricDelta(10, 20, "neutral")).toMatchObject({ tone: "neutral" })
  for (const missing of [null, undefined, NaN, Infinity, "12"]) {
    expect(metricDelta(1, missing, "increase")).toEqual({
      available: false,
      reason: "No previous data",
    })
    expect(metricDelta(missing, 1, "increase")).toEqual({
      available: false,
      reason: "No current data",
    })
  }
  expect(defaultMetricTrendDirection("logs.erroredCount")).toBe("decrease")
  expect(defaultMetricTrendDirection("traces.errorRate")).toBe("decrease")
  expect(defaultMetricTrendDirection("logs.p95LatencyMs")).toBe("decrease")
  expect(defaultMetricTrendDirection("scores.explicitPassRate")).toBe(
    "increase"
  )
  expect(defaultMetricTrendDirection("traces.count")).toBe("neutral")
  expect(defaultMetricTrendDirection("scores.meanValue")).toBe("neutral")
  expect(
    dashboardWidgetSchema.parse({ ...widget, trendDirection: "increase" })
      .trendDirection
  ).toBe("increase")
  expect(dashboardWidgetSchema.parse(widget).trendDirection).toBeUndefined()
})

test("database comparison uses the same filtered snapshot and half-open windows; rates use each period's denominator", async () => {
  const db = await createTracerFixture()
  try {
    await db.insert(traces).values(
      scopeRows(
        db,
        [
          {
            id: "old-excluded",
            status: "errored",
            startedAt: "2026-08-29T23:59:59.999Z",
          },
          {
            id: "prior-start",
            status: "errored",
            startedAt: "2026-08-30T00:00:00Z",
          },
          {
            id: "prior-error",
            status: "errored",
            startedAt: "2026-09-05T23:59:59.999Z",
          },
          {
            id: "prior-success",
            status: "completed",
            startedAt: "2026-09-03T00:00:00Z",
          },
          {
            id: "prior-running",
            status: "running",
            startedAt: "2026-09-03T00:00:00Z",
          },
          {
            id: "current-start",
            status: "errored",
            startedAt: "2026-09-06T00:00:00Z",
          },
          {
            id: "current-success",
            status: "completed",
            startedAt: "2026-09-07T00:00:00Z",
          },
          {
            id: "current-cancelled",
            status: "cancelled",
            startedAt: "2026-09-07T00:00:00Z",
          },
          {
            id: "wrong-operation",
            status: "errored",
            startedAt: "2026-09-07T00:00:00Z",
            operation: "search",
          },
          {
            id: "end-excluded",
            status: "errored",
            startedAt: "2026-09-13T00:00:00Z",
          },
        ].map((row) => ({ operation: "chat", name: "Answer", ...row }))
      )
    )
    const rate = {
      ...widget,
      id: "rate",
      query: { ...widget.query, measures: ["traces.errorRate"] },
    }
    const plan = dashboardQueryPlan([widget, rate], {})
    const results = await executeSemanticBatch(
      { queries: plan.batches[0] },
      {
        catalog: semanticCatalog,
        requestId: "metric-comparison",
        snapshotRunner: createSemanticSnapshotRunner(db),
      }
    )
    const scalars = plan.positions.flatMap(({ cohorts }) =>
      cohorts.flatMap(({ result, previous }) => [
        results[result],
        results[previous!],
      ])
    )
    expect(scalars.map((r) => r.data[0][r.query.measures[0]])).toEqual([
      1,
      2,
      0.5,
      2 / 3,
    ])
    const counts = results[plan.positions[0].cohorts[0].history!]
    const rates = results[plan.positions[1].cohorts[0].history!]
    expect(dashboardMetricHistory(counts).map((row) => row.value)).toEqual([
      1, 0, 0, 0, 0, 0, 0,
    ])
    expect(dashboardMetricHistory(rates).map((row) => row.value)).toEqual([
      1,
      0,
      null,
      null,
      null,
      null,
      null,
    ])
    expect(dashboardMetricHistory(counts).map((row) => row.date)).toEqual(
      Array.from(
        { length: 7 },
        (_, index) => `2026-09-${String(index + 6).padStart(2, "0")}`
      )
    )
    const dstHistory = {
      ...counts,
      query: {
        ...counts.query,
        timezone: "America/New_York",
        timeDimensions: [
          {
            ...counts.query.timeDimensions[0],
            dateRange: [
              "2026-03-07T00:00:00-05:00",
              "2026-03-09T00:00:00-04:00",
            ] as [string, string],
          },
        ],
      },
      data: [],
    }
    expect(dashboardMetricHistory(dstHistory)).toEqual([
      { date: "2026-03-07", value: 0 },
      { date: "2026-03-08", value: 0 },
    ])
    expect(new Set(results.map((r) => r.meta.asOf)).size).toBe(1)
    expect(results[0].query.filters).toEqual(results[1].query.filters)
  } finally {
    await closeTracerFixture(db)
  }
})
