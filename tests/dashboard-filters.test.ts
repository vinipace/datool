import { describe, expect, test } from "bun:test"
import { dashboardWidgetSchema } from "@/src/lib/tracer/dashboards"
import {
  dashboardCohorts,
  dashboardGroupFilters,
} from "@/src/lib/tracer/dashboard-filters"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { comparisonTimeChart } from "@/components/tracer/dashboard-comparison"
import { semanticResultForQuery } from "@/.storybook/scenarios/dashboards/fixtures"

const widget = dashboardWidgetSchema.parse({
  id: "cost",
  title: "Cost",
  type: "stacked",
  width: 1,
  query: {
    measures: ["logs.costUsd"],
    timeDimensions: [
      {
        dimension: "logs.startedAt",
        granularity: "day",
        dateRange: ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"],
      },
    ],
    filters: [
      {
        member: "logs.parent.status",
        operator: "equals",
        values: ["completed"],
      },
    ],
  },
  groups: [
    { type: "agent", name: "Research", versions: ["v1", "v2"] },
    { type: "agent", name: "Other" },
    { type: "workflow", name: "Briefing" },
  ],
  compare: { type: "agent", name: "Research" },
})

describe("dashboard invocation filters", () => {
  test("binds versions to names, ORs each type and preserves existing filters", () => {
    const filters = dashboardGroupFilters("logs", widget.groups!)
    expect(filters).toHaveLength(2)
    expect("values" in filters[0] && filters[0].values).toHaveLength(2)
    const cohorts = dashboardCohorts(widget)
    expect(cohorts.map((cohort) => cohort.label)).toEqual([
      "Research · v1",
      "Research · v2",
    ])
    expect(cohorts[0].query.filters[0]).toEqual(widget.query.filters[0])
    const encoded = JSON.stringify(cohorts[0].query.filters)
    expect(encoded).toContain("Briefing")
    expect(encoded).not.toContain("Other")
    expect(encoded).not.toContain("v2")
    expect(
      dashboardCohorts({ ...widget, groups: [], compare: undefined })[0].query
        .filters
    ).toEqual(widget.query.filters)
  })
  test("requires two explicit versions and bounds comparisons", () => {
    expect(
      dashboardWidgetSchema.safeParse({ ...widget, groups: [] }).success
    ).toBe(false)
    expect(
      dashboardWidgetSchema.safeParse({
        ...widget,
        groups: [{ type: "agent", name: "Research", versions: ["v1", "v1"] }],
      }).success
    ).toBe(false)
    expect(
      dashboardWidgetSchema.safeParse({
        ...widget,
        groups: [{ type: "agent", name: "Research", versions: [null, "v1"] }],
      }).success
    ).toBe(true)
    expect(
      dashboardWidgetSchema.safeParse({
        ...widget,
        groups: [
          {
            type: "agent",
            name: "Research",
            versions: Array.from({ length: 7 }, (_, index) => String(index)),
          },
        ],
      }).success
    ).toBe(false)
  })
  test("keeps every comparison and its summaries in one bounded batch", () => {
    const plan = dashboardQueryPlan(
      Array.from({ length: 20 }, (_, index) => ({
        ...widget,
        id: String(index),
      })),
      {}
    )
    expect(plan.batches.map((batch) => batch.length)).toEqual([40, 40])
    expect(
      plan.positions[0].cohorts.map((cohort) => [cohort.result, cohort.summary])
    ).toEqual([
      [0, 1],
      [2, 3],
    ])
    expect(plan.batches[0][1].timeDimensions[0].granularity).toBeUndefined()
    expect(
      dashboardQueryPlan([widget], { "cost:1": 100 }).batches[0][2].offset
    ).toBe(100)
  })
  test("pivots independent series and totals without summing percentiles or versions", () => {
    const cohorts = dashboardCohorts(widget).map((cohort, index) => {
      const result = semanticResultForQuery(cohort.query)
      const summary = semanticResultForQuery({
        ...cohort.query,
        timeDimensions: cohort.query.timeDimensions.map(
          ({ dimension, dateRange }) => ({ dimension, dateRange })
        ),
      })
      result.data = [
        { "logs.startedAt": "2026-09-01", "logs.costUsd": index + 1 },
      ]
      summary.data = [{ "logs.costUsd": (index + 1) * 5 }]
      return { ...cohort, result, summary, offsetKey: String(index) }
    })
    const view = comparisonTimeChart(widget, cohorts)
    expect(view.result.data[0]).toEqual({
      "logs.startedAt": "2026-09-01",
      "comparison.c0m0": 1,
      "comparison.c1m0": 2,
    })
    expect(view.summary?.data[0]).toEqual({
      "comparison.c0m0": 5,
      "comparison.c1m0": 10,
    })
    expect(view.stackGroups["comparison.c0m0"]).not.toEqual(
      view.stackGroups["comparison.c1m0"]
    )
    expect(view.result.annotation.measures["comparison.c1m0"].title).toContain(
      "Research · v2"
    )
  })
  test("thresholded time charts preserve cohort filters without misleading whole-window totals", () => {
    const filtered = {
      ...widget,
      query: {
        ...widget.query,
        having: [
          { member: "logs.costUsd", operator: "gt" as const, values: [2] },
        ],
      },
    }
    const plan = dashboardQueryPlan([filtered], {})
    expect(plan.batches[0]).toHaveLength(2)
    expect(
      plan.positions[0].cohorts.every((cohort) => cohort.summary === null)
    ).toBe(true)
    expect(
      plan.batches[0].every((query) => query.having?.[0].values?.[0] === 2)
    ).toBe(true)
    const view = comparisonTimeChart(
      filtered,
      plan.batches[0].map((query, index) => ({
        result: semanticResultForQuery(query),
        summary: null,
        offsetKey: String(index),
      }))
    )
    expect(view.summary).toBeNull()
    expect(view.result.data.length).toBeGreaterThan(0)
  })
})
