import { expect, test } from "bun:test"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import { dashboardBarBaseline } from "@/src/lib/tracer/dashboard-bar-comparison"
import { metricDelta } from "@/src/lib/tracer/dashboard-metric-comparison"

const widget = dashboardWidgetSchema.parse({
  id: "latency",
  type: "bar",
  title: "Latency",
  width: 1,
  query: {
    measures: ["traces.p95DurationMs"],
    dimensions: ["traces.agentVersion"],
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: ["2026-09-22T00:00:00Z", "2026-09-27T00:00:00Z"],
      },
    ],
    order: [["traces.agentVersion", "asc"]],
    limit: 2,
  },
})
const result = {
  query: widget.query,
  data: [6336, 6864, 3960, 2112].map((value, index) => ({
    "traces.agentVersion": `v${index + 1}`,
    "traces.p95DurationMs": value,
  })),
}

test("latency comparisons use the frozen v1 baseline, with decreases classified as improvements", () => {
  const baseline = dashboardBarBaseline(widget, result)!
  expect(baseline.row?.["traces.agentVersion"]).toBe("v1")
  expect(baseline.value).toBe(6336)
  expect(metricDelta(6864, baseline.value, baseline.direction)).toMatchObject({
    tone: "negative",
    absolute: 528,
    relative: 1 / 12,
  })
  expect(metricDelta(3960, baseline.value, baseline.direction)).toMatchObject({
    tone: "positive",
    absolute: -2376,
    relative: -0.375,
  })
  expect(metricDelta(2112, baseline.value, baseline.direction)).toMatchObject({
    tone: "positive",
    absolute: -4224,
    relative: -2 / 3,
  })
  // Resolve once from the snapshot, then reuse when v1 is no longer on screen.
  const secondPage = result.data.slice(2)
  expect(
    secondPage.map(
      (row) =>
        metricDelta(
          row["traces.p95DurationMs"],
          baseline.value,
          baseline.direction
        ).available
    )
  ).toEqual([true, true])
  expect(
    dashboardBarBaseline(widget, {
      ...result,
      query: { ...result.query, offset: 2 },
      data: secondPage,
    })
  ).toBeUndefined()
})

test("cost references take priority over order and preserve lower-is-better semantics", () => {
  const costWidget = dashboardWidgetSchema.parse({
    ...widget,
    id: "cost",
    query: {
      measures: ["evalClassification.costUsd"],
      dimensions: ["evalClassification.groupVersion"],
      timeDimensions: [
        {
          dimension: "evalClassification.createdAt",
          dateRange: ["2026-09-22T00:00:00Z", "2026-09-27T00:00:00Z"],
        },
      ],
      classification: {
        actualPath: ["actual"],
        predictedPath: ["predicted"],
        positiveClass: true,
      },
    },
  })
  const costResult = {
    ...result,
    query: costWidget.query,
    data: [12, 10, 7.2, 3.6].map((value) => ({
      "evalClassification.costUsd": value,
      "evalClassification.groupVersion": String(value),
    })),
  }
  const reference = {
    widgetId: "cost",
    measure: "evalClassification.costUsd",
    value: 10,
    label: "Baseline cost",
  }
  const baseline = dashboardBarBaseline(costWidget, costResult, [reference])!
  expect(baseline.value).toBe(10)
  expect(metricDelta(12, baseline.value, baseline.direction)).toMatchObject({
    absolute: 2,
    relative: 0.2,
    tone: "negative",
  })
  expect(metricDelta(3.6, baseline.value, baseline.direction)).toMatchObject({
    absolute: -6.4,
    relative: -0.64,
    tone: "positive",
  })
  expect(
    dashboardBarBaseline(costWidget, costResult, [
      reference,
      { ...reference, value: 12 },
    ])
  ).toBeUndefined()
})

test("missing and zero baselines are not turned into fabricated percentages", () => {
  expect(
    dashboardBarBaseline(widget, {
      ...result,
      data: [{ "traces.agentVersion": "v1", "traces.p95DurationMs": null }],
    })
  ).toBeUndefined()
  expect(
    dashboardBarBaseline(widget, {
      ...result,
      query: { ...result.query, order: [["traces.p95DurationMs", "desc"]] },
    })
  ).toBeUndefined()
  expect(metricDelta(10, 0, "decrease")).toMatchObject({
    available: true,
    absolute: 10,
    relative: null,
    tone: "negative",
  })
  expect(metricDelta(null, 6336, "decrease").available).toBe(false)
})
