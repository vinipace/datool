import { expect, test } from "bun:test"
import { parseSemanticQuery } from "@/src/lib/semantic/query"
import { dashboardTraceFilter } from "@/src/lib/tracer/dashboard-trace-links"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"

const query = parseSemanticQuery({
  measures: ["logs.costUsd"],
  dimensions: ["logs.functionName"],
  timeDimensions: [
    {
      dimension: "logs.startedAt",
      dateRange: ["2026-09-01T00:00:00Z", "2026-09-16T00:00:00Z"],
    },
  ],
  filters: traceExpressionFilters(
    'status = completed metadata."ai.model.id" = "gpt" "existing search"',
    "logs",
    0
  ),
})

test("bar links preserve dates and trace filters, escaping names as literal text", () => {
  const name = 'billing: "invoice" C:\\files %_São'
  const filter = dashboardTraceFilter(query, "logs.functionName", name)!
  const parsed = traceExpressionFilters(filter, "logs", 0)
  expect(parsed[0]).toEqual({
    member: "logs.parent.functionName",
    operator: "equals",
    values: [name],
  })
  expect(parsed[1]).toMatchObject({
    member: "logs.parent.startedAt",
    operator: "gte",
    values: ["2026-09-01T00:00:00.000Z"],
  })
  expect(parsed[2]).toMatchObject({
    member: "logs.parent.startedAt",
    operator: "lt",
    values: ["2026-09-16T00:00:00.000Z"],
  })
  expect(parsed.slice(3)).toEqual(query.filters)
  expect(
    new URLSearchParams(new URLSearchParams({ filter }).toString()).get(
      "filter"
    )
  ).toBe(filter)
})

test("request names and span names use exact name comparisons", () => {
  expect(
    dashboardTraceFilter(query, "logs.traceName", "request")?.startsWith(
      'name = "request"'
    )
  ).toBe(true)
  expect(
    dashboardTraceFilter(query, "logs.spanName", "call")?.startsWith(
      'traceOrSpanName = "call"'
    )
  ).toBe(true)
})

test("span-source links preserve literal values that resemble member names", () => {
  const spanQuery = parseSemanticQuery({
    measures: ["spans.costUsd"],
    dimensions: ["spans.functionName"],
    timeDimensions: [
      { ...query.timeDimensions[0], dimension: "spans.startedAt" },
    ],
    filters: [
      {
        member: "spans.parent.metadata",
        path: ["spans.key"],
        operator: "equals",
        values: ["spans.value"],
      },
    ],
  })
  const filter = dashboardTraceFilter(
    spanQuery,
    "spans.functionName",
    "spans.call"
  )!
  const parsed = traceExpressionFilters(filter, "logs", 0)
  expect(parsed[0]).toMatchObject({ values: ["spans.call"] })
  expect(parsed[3]).toMatchObject({
    member: "logs.parent.metadata",
    path: ["spans.key"],
    values: ["spans.value"],
  })
})

test("unsupported scopes and missing names do not produce misleading links", () => {
  expect(dashboardTraceFilter(query, "logs.functionName", null)).toBeUndefined()
  expect(dashboardTraceFilter(query, "logs.functionName", "")).toBeUndefined()
  expect(dashboardTraceFilter(query, "logs.agentName", "agent")).toBeUndefined()
  expect(
    dashboardTraceFilter(
      {
        ...query,
        filters: [
          {
            member: "logs.spanStatus",
            operator: "equals",
            values: ["errored"],
          },
        ],
      },
      "logs.functionName",
      "call"
    )
  ).toBeUndefined()
  expect(
    dashboardTraceFilter(
      { ...query, filters: [{ or: query.filters }] },
      "logs.functionName",
      "call"
    )
  ).toBeUndefined()
})

test("positive-cost rankings still link to related traces", () => {
  expect(
    dashboardTraceFilter(
      {
        ...query,
        filters: [
          ...query.filters,
          { member: "logs.spanCostUsd", operator: "gt", values: [0] },
        ],
      },
      "logs.functionName",
      "call"
    )
  ).toBeDefined()
})
