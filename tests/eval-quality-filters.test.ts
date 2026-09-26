import { expect, test } from "bun:test"
import { evalQualityExpressionFilters } from "../src/lib/tracer/eval-quality-filters"
import {
  dashboardFilterScope,
  scopedWidget,
} from "../src/lib/tracer/dashboard-queries"
import { semanticQuerySchema } from "../src/lib/semantic/query"
import type { DashboardWidget } from "../src/lib/tracer/dashboards"

test("evaluation dashboard filters retain dates and chart-specific grouping", () => {
  const widget: DashboardWidget = {
    id: "agents",
    title: "Agents",
    type: "table",
    width: 2,
    query: semanticQuerySchema.parse({
      measures: ["evalQuality.meanScore"],
      dimensions: ["evalQuality.groupName"],
      filters: [
        {
          member: "evalQuality.groupType",
          operator: "equals",
          values: ["agent"],
        },
      ],
      timeDimensions: [
        {
          dimension: "evalQuality.completedAt",
          dateRange: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
        },
      ],
    }),
  }
  const scope = dashboardFilterScope(
    'startedAt >= -7d workflow = "Answer" model = "alpha" evaluatorName contains "Quality"',
    Date.parse("2026-09-20T00:00:00Z"),
    "UTC"
  )
  const scoped = scopedWidget(widget, scope)
  expect(scoped.query.timeDimensions[0].dateRange).toEqual([
    "2026-09-13T00:00:00.000Z",
    "2026-09-20T00:00:00.000Z",
  ])
  expect(scoped.query.filters).toEqual([
    ...widget.query.filters,
    { member: "evalQuality.workflow", operator: "equals", values: ["Answer"] },
    { member: "evalQuality.model", operator: "equals", values: ["alpha"] },
    {
      member: "evalQuality.evaluatorName",
      operator: "contains",
      values: ["Quality"],
    },
  ])
  expect(evalQualityExpressionFilters("groupName contains extract")).toEqual([
    {
      member: "evalQuality.groupName",
      operator: "contains",
      values: ["extract"],
    },
  ])
  expect(() => evalQualityExpressionFilters("metadata.secret = true")).toThrow()
})
