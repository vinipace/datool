import { expect, test } from "bun:test"
import { parseSemanticQuery } from "@/src/lib/semantic/query"
import { dashboardCachePlan } from "@/src/lib/tracer/dashboard-cache"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { previousPeriodQuery } from "@/src/lib/tracer/dashboard-metric-comparison"
import { stableCacheJson } from "@/src/server/cache/stale-while-revalidate"
const now = Date.parse("2026-09-16T12:00:00Z")
function input(dateFilter = "startedAt >= -90d", rangeEnd = now) {
  const scope = dashboardFilterScope(dateFilter, rangeEnd, "America/Sao_Paulo")
  const query = parseSemanticQuery({
    measures: ["logs.costUsd"],
    dimensions: ["logs.functionName"],
    timezone: scope.timezone,
    timeDimensions: [
      { dimension: "logs.startedAt", dateRange: [scope.from, scope.to] },
    ],
    filters: [{ member: "logs.spanCostUsd", operator: "gt", values: [0] }],
  })
  return {
    queries: [query, previousPeriodQuery(query)],
    hint: { dateFilter, rangeEnd },
  }
}
test("relative date selections share keys across reloads and retain actual result windows", () => {
  const a = input(),
    b = input("startedAt >= -90d", now + 20000)
  const first = dashboardCachePlan(a.queries, a.hint, now)!
  const second = dashboardCachePlan(b.queries, b.hint, now + 20000)!
  expect(stableCacheJson(first.key)).toBe(stableCacheJson(second.key))
  expect(first.queries[0].timeDimensions[0].dateRange).not.toEqual(
    second.queries[0].timeDimensions[0].dateRange
  )
  expect(second.queries[1]).toEqual(previousPeriodQuery(second.queries[0]))
  expect(second.queries[0].filters).toEqual(b.queries[0].filters)
})
test("absolute windows remain fixed; changes to range, filters and pages have different keys", () => {
  const a = input('startedAt >= "2026-09-01" startedAt < "2026-09-10"')
  const plan = dashboardCachePlan(a.queries, a.hint, now)!
  expect(dashboardCachePlan(a.queries, a.hint, now + 100000)!.queries).toEqual(
    plan.queries
  )
  const altered = a.queries.map((query) => ({ ...query, offset: 10 }))
  expect(
    stableCacheJson(dashboardCachePlan(altered, a.hint, now)!.key)
  ).not.toBe(stableCacheJson(plan.key))
  const b = input("startedAt >= -7d")
  expect(
    stableCacheJson(dashboardCachePlan(b.queries, b.hint, now)!.key)
  ).not.toBe(stableCacheJson(plan.key))
})
test("additional user filters and unproven query windows bypass the cache", () => {
  const a = input()
  expect(
    dashboardCachePlan(
      a.queries,
      { ...a.hint, dateFilter: "startedAt >= -90d status = completed" },
      now
    )
  ).toBeNull()
  expect(
    dashboardCachePlan(
      a.queries,
      { ...a.hint, dateFilter: 'startedAt >= -90d "search"' },
      now
    )
  ).toBeNull()
  expect(() =>
    dashboardCachePlan(a.queries, { ...a.hint, rangeEnd: now + 1 }, now)
  ).toThrow()
  expect(
    dashboardFilterScope("startedAt >= -90d status = completed", now, "UTC")
      .dateFilter
  ).toBeUndefined()
})
test("revalidation resolves rolling windows using server time, not an old browser anchor", () => {
  const a = input()
  const plan = dashboardCachePlan(a.queries, a.hint, now + 600000)!
  expect(plan.queries[0].timeDimensions[0].dateRange[1]).toBe(
    new Date(now + 600000).toISOString()
  )
})
