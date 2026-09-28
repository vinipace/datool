import { expect, test } from "bun:test"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  dashboardCategoryColors,
  dashboardCategoryKey,
  dashboardSeriesColor,
} from "@/components/tracer/dashboard-chart-style"

test("report category colors agree across metrics, source models, and page order", () => {
  const versions = [
    "v1 · Baseline",
    "v2 · Instructions",
    "v3 · Grounding",
    "v4 · Candidate",
  ]
  const cost = {
    query: semanticQuerySchema.parse({
      measures: ["evalClassification.costUsd"],
      dimensions: ["evalClassification.groupVersion"],
      classification: {
        actualPath: ["actual"],
        predictedPath: ["predicted"],
        positiveClass: true,
      },
    }),
    data: versions.map((version) => ({
      "evalClassification.groupVersion": version,
      "evalClassification.costUsd": 1,
    })),
  }
  const latency = {
    query: semanticQuerySchema.parse({
      measures: ["traces.p95DurationMs"],
      dimensions: ["traces.agentVersion"],
    }),
    data: [...versions]
      .reverse()
      .map((version) => ({
        "traces.agentVersion": version,
        "traces.p95DurationMs": 2,
      })),
  }
  const colors = dashboardCategoryColors([cost, latency])
  expect(new Set([...colors.values()].map(dashboardSeriesColor)).size).toBe(4)
  for (let index = 0; index < versions.length; index++) {
    expect(
      colors.get(dashboardCategoryKey(cost.data[index], cost.query.dimensions))
    ).toBe(
      colors.get(
        dashboardCategoryKey(latency.data[3 - index], latency.query.dimensions)
      )
    )
  }
  expect(dashboardCategoryColors([latency, cost])).toEqual(colors)
  // A frozen chart page looks up the same full-snapshot registry.
  const page = latency.data.slice(2)
  expect(
    page.map((row) =>
      colors.get(dashboardCategoryKey(row, latency.query.dimensions))
    )
  ).toEqual([1, 0])
})
