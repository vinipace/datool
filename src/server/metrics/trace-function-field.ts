import { sql } from "drizzle-orm"
import { parseSemanticQuery } from "@/src/lib/semantic/query"
import { spans, traces } from "@/src/server/tracer/schema"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { costAttributionSql } from "./cost-attribution-sql"

/** Use the chart's own ancestry attribution rather than guessing from span names. */
export function traceFunctionField(): SqlFilterField {
  const attribution = costAttributionSql(
    parseSemanticQuery({
      measures: ["logs.llmCount"],
      dimensions: ["logs.functionName"],
    })
  )
  return {
    type: "string",
    value: sql`null`,
    predicate(filter) {
      const positive = {
        notEquals: "equals",
        notIn: "in",
        notContains: "contains",
        notSet: "set",
      } as const
      const operator = positive[filter.operator as keyof typeof positive]
      const match = semanticSqlFilters(
        [
          {
            ...filter,
            member: "logs.functionName",
            operator: operator ?? filter.operator,
          },
        ],
        attribution.fields
      )
      const exists = sql`exists (
        select 1 from ${spans} ${attribution.join}
        where ${spans.projectId} = ${traces.projectId}
          and ${spans.traceId} = ${traces.id}
          and ${spans.kind} = 'llm'
          and ${match}
      )`
      return operator ? sql`not (${exists})` : exists
    },
  }
}
