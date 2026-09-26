import type { NormalizedSemanticQuery, SemanticFilter } from "../semantic/query"
import { quoteFilterText } from "@/components/ui/datool/search-bar/filter-draft"
import {
  parseFilterQuery,
  validateFilterFields,
} from "@/components/ui/datool/search-bar/filter-query"
import { collectionFilterFields } from "./collection-filters"

const dimensions: Record<string, string> = {
  "logs.functionName": "functionName",
  "logs.spanName": "traceOrSpanName",
  "logs.traceName": "name",
}
const operators: Record<string, string> = {
  equals: "=",
  notEquals: "!=",
  contains: "contains",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
}
const literal = (value: unknown) =>
  typeof value === "string" ? quoteFilterText(value) : String(value)

/** Name-based navigation; preserve trace scope and reject unsupported filters. */
export function dashboardTraceFilter(
  query: NormalizedSemanticQuery,
  dimension: string,
  value: unknown
): string | undefined {
  const namespace = dimension.startsWith("spans.") ? "spans" : "logs"
  const field = dimensions[dimension.replace(/^spans[.]/, "logs.")]
  const window = query.timeDimensions.find(
    (t) => t.dimension === `${namespace}.startedAt`
  )?.dateRange
  if (
    !field ||
    !window ||
    typeof value !== "string" ||
    !value ||
    query.segments.length
  )
    return
  if (
    !query.measures.every((m) =>
      [
        `${namespace}.costUsd`,
        `${namespace}.tokenCount`,
        `${namespace}.llmCount`,
        `${namespace}.inputTokens`,
        `${namespace}.outputTokens`,
        `${namespace}.cacheTokens`,
      ].includes(m)
    )
  )
    return
  const clauses = [
    `${field} = ${literal(value)}`,
    `startedAt >= ${quoteFilterText(window[0])}`,
    `startedAt < ${quoteFilterText(window[1])}`,
  ]
  const append = (filters: SemanticFilter[]): boolean =>
    filters.every((filter) => {
      if ("and" in filter) return append(filter.and)
      if (!("member" in filter)) return false
      // Ranking charts restrict costs to positive contributions. Navigation opens
      // related traces by name, including their other spans and contributions.
      if (
        filter.member === `${namespace}.spanCostUsd` &&
        filter.operator === "gt" &&
        filter.values?.length === 1 &&
        filter.values[0] === 0
      )
        return true
      const target = filter.member.startsWith(`${namespace}.parent.`)
        ? filter.member.slice(`${namespace}.parent.`.length)
        : undefined
      if (!target) return false
      if (
        target === "fullText" &&
        filter.operator === "contains" &&
        filter.values?.length === 1 &&
        typeof filter.values[0] === "string"
      ) {
        clauses.push(quoteFilterText(filter.values[0]))
        return true
      }
      const operator = operators[filter.operator]
      if (!operator || filter.values?.length !== 1) return false
      const path = [target, ...(filter.path ?? [])]
        .map(quoteFilterText)
        .join(".")
      clauses.push(`${path} ${operator} ${literal(filter.values[0])}`)
      return true
    })
  if (!append(query.filters)) return
  const expression = clauses.join(" ")
  try {
    validateFilterFields(
      parseFilterQuery(expression),
      collectionFilterFields.traces
    )
  } catch {
    return
  }
  return expression
}
