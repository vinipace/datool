import { sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { spans, traces } from "@/src/server/tracer/schema"
import {
  traceFieldMember,
  traceFullTextMember,
} from "@/src/lib/semantic/trace-filters"
import { fullTextFields } from "@/components/ui/datool/search-bar/filter-query"
import { collectionFilterFields } from "@/src/lib/tracer/collection-filters"
import {
  fullTextSqlField,
  fullTextSqlFilter,
} from "@/src/server/semantic/full-text-filter"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { invocationSqlField } from "./group-filter"
import { traceFunctionField } from "./trace-function-field"

// All descendants carry traceId. A scoped EXISTS covers every depth without
// duplicating traces or narrowing an outer logs query to just matching spans.
const searchSpan = alias(spans, "search_span")
const spanTextFields: SqlFilterField[] = [
  searchSpan.id,
  searchSpan.name,
  searchSpan.kind,
  searchSpan.groupType,
  searchSpan.groupName,
  searchSpan.groupVersion,
  searchSpan.status,
].map((column) => ({ value: sql`${column}`, type: "string" }))
spanTextFields.push(
  { value: sql`${searchSpan.inputJson}`, type: "json" },
  { value: sql`${searchSpan.outputJson}`, type: "json" },
  { value: sql`${searchSpan.attributesJson}`, type: "json", nativeJson: true }
)

export function traceSqlFields(model: string): Record<string, SqlFilterField> {
  const attributes = sql`${traces.attributesJson}`
  const duration = sql`${traces.endedAtMs} - ${traces.startedAtMs}`
  const fields: Record<string, SqlFilterField> = {
    groupType: { value: sql`${traces.groupType}`, type: "string" },
    groupName: {
      value: sql`${traces.groupName}`,
      type: "string",
      caseSensitive: true,
    },
    groupVersion: {
      value: sql`${traces.groupVersion}`,
      type: "string",
      caseSensitive: true,
    },
    id: { value: sql`${traces.id}`, type: "string" },
    name: { value: sql`${traces.name}`, type: "string" },
    operation: { value: sql`${traces.operation}`, type: "string" },
    sessionId: { value: sql`${traces.sessionId}`, type: "string" },
    status: { value: sql`${traces.status}`, type: "string" },
    startedAt: {
      value: sql`${traces.startedAt}`,
      instant: sql`${traces.startedAtMs}`,
      type: "date",
    },
    endedAt: {
      value: sql`${traces.endedAt}`,
      instant: sql`${traces.endedAtMs}`,
      type: "date",
    },
    durationMs: {
      value: sql`case when ${duration} >= 0 then ${duration} end`,
      type: "number",
    },
    attributes: { value: attributes, type: "json", nativeJson: true },
    metadata: { value: attributes, type: "json", nativeJson: true },
    input: { value: sql`coalesce(${traces.inputJson}, 'null')`, type: "json" },
    output: {
      value: sql`coalesce(${traces.outputJson}, 'null')`,
      type: "json",
    },
    metrics: {
      value: sql`coalesce(${attributes} -> 'metrics', 'null'::jsonb)`,
      type: "json",
      nativeJson: true,
    },
  }
  const nameField: SqlFilterField = {
    value: sql`${traces.name}`,
    type: "string",
    predicate: (filter) => {
      // Negation excludes a trace if any of its names match.
      const positive = {
        notEquals: "equals",
        notIn: "in",
        notContains: "contains",
        notSet: "set",
      } as const
      const operator = positive[filter.operator as keyof typeof positive]
      const condition = { ...filter, operator: operator ?? filter.operator }
      const match = (value: typeof nameField.value) =>
        semanticSqlFilters([condition], {
          [filter.member]: { value, type: "string" },
        })
      const matches = sql`(coalesce(${match(sql`${traces.name}`)}, false) or exists (
        select 1 from ${spans} as ${searchSpan}
        where ${searchSpan.projectId} = ${traces.projectId}
          and ${searchSpan.traceId} = ${traces.id}
          and ${match(sql`${searchSpan.name}`)}
      ))`
      return operator ? sql`not (${matches})` : matches
    },
  }
  return {
    [traceFieldMember(model, "traceOrSpanName")]: nameField,
    [traceFieldMember(model, "functionName")]: traceFunctionField(),
    [traceFullTextMember(model)]: fullTextSqlField(
      fullTextFields(collectionFilterFields.traces)
        .filter(
          (field) =>
            field.id !== "traceOrSpanName" && field.id !== "functionName"
        )
        .map((field) => fields[field.id]),
      (text) => sql`exists (
        select 1 from ${spans} as ${searchSpan}
        where ${searchSpan.projectId} = ${traces.projectId}
          and ${searchSpan.traceId} = ${traces.id}
          and ${fullTextSqlFilter(spanTextFields, text)}
      )`
    ),
    [`${model}.invocationGroup`]: invocationSqlField(
      sql`${traces.projectId}`,
      sql`${traces.id}`
    ),
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        traceFieldMember(model, key),
        value,
      ])
    ),
  }
}
