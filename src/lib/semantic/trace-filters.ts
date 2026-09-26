import {
  parseFilterQuery,
  validateFilterFields,
  filterDate,
} from "@/components/ui/datool/search-bar/filter-query"
import { collectionFilterFields } from "@/src/lib/tracer/collection-filters"
import type { SemanticDimensionDefinition } from "./model"
import type { SemanticFilter, SemanticFilterOperator } from "./query"
import { invocationFilterMember } from "./group-filter"

const operators = {
  "=": "equals",
  "!=": "notEquals",
  ":": "contains",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
} as const
export const traceFilterOperators: SemanticFilterOperator[] = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "set",
  "notSet",
]
export const traceFieldMember = (model: string, field: string) =>
  `${model}.parent.${field}`
export const traceFullTextMember = (model: string) => `${model}.parent.fullText`

/** The editor is syntax only: queries carry catalog members, typed values and JSON paths. */
export function traceExpressionFilters(
  expression: string,
  model: string,
  now: number
): SemanticFilter[] {
  const clauses = parseFilterQuery(expression)
  validateFilterFields(clauses, collectionFilterFields.traces)
  return clauses.map((clause) => {
    if ("text" in clause) {
      return {
        member: traceFullTextMember(model),
        operator: "contains",
        values: [clause.text],
      }
    }
    const { path, operator, value } = clause
    const field = collectionFilterFields.traces.find((f) => f.id === path[0])!
    const resolved =
      field.kind === "date" && typeof value === "string"
        ? new Date(filterDate(value, now)).toISOString()
        : value
    return {
      member: traceFieldMember(model, path[0]),
      ...(path.length > 1 ? { path: path.slice(1) } : {}),
      operator:
        operator === ":" && (typeof value !== "string" || field.kind === "date")
          ? "equals"
          : operators[operator],
      values: [resolved],
    }
  })
}

export function traceRelationshipMembers(
  model: string,
  version: string
): SemanticDimensionDefinition[] {
  return [
    invocationFilterMember(model, version),
    {
      name: traceFullTextMember(model),
      kind: "dimension",
      type: "string",
      title: "Trace full text",
      description:
        "Search text across the parent trace and all of its descendant spans.",
      definition:
        "Case-insensitive substring matching of trace and span text fields and nested JSON string values at any depth before aggregation. Each matching trace is included once; span matches are independent of the span time window.",
      metricVersion: version,
      groupable: false,
      filterOperators: ["contains"],
    },
    ...collectionFilterFields.traces.map(
      (field) =>
        ({
          name: traceFieldMember(model, field.id),
          kind: "dimension",
          type: field.kind === "number" ? "number" : "string",
          title: `Trace ${field.id}`,
          description:
            field.id === "traceOrSpanName"
              ? "Filter by the trace name or any descendant span name."
              : field.id === "functionName"
                ? "Filter traces with LLM calls attributed to this function."
                : `Filter by the parent trace's ${field.id}.`,
          definition:
            field.id === "traceOrSpanName"
              ? "Match trace or descendant span names before pagination and aggregation, independently of the span time window; each trace is included once. Negative operators exclude traces with any matching name."
              : field.id === "functionName"
                ? "Uses the same nearest-ancestor function attribution as logs.functionName, including telemetry function IDs and function/agent fallbacks. Matches any LLM call in the trace, independently of the span time window."
                : `Persisted parent trace ${field.id}; applied before aggregation, independently of the span time window.`,
          metricVersion: version,
          groupable: false,
          filterOperators: traceFilterOperators,
          ...(field.kind === "json"
            ? { filterValueType: "json" as const }
            : field.kind === "date"
              ? { filterValueType: "date" as const }
              : {}),
        }) satisfies SemanticDimensionDefinition
    ),
  ]
}
