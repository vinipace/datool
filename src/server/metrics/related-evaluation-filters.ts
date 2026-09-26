import { sql } from "drizzle-orm"
import { traces } from "@/src/server/tracer/schema"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { sourceDimension } from "./source-contract"

const definitions = [
  ["scorerId", "Related scorer", "e.evaluator_id"],
  ["scorerVersionId", "Related scorer version", "e.evaluator_version_id"],
  ["datasetId", "Related dataset", "item.dataset_id"],
  ["caseId", "Related case", "e.target_id"],
] as const
export const relatedEvaluationMembers = (model: string) =>
  definitions.map(([key, title]) =>
    sourceDimension(
      model,
      key,
      title,
      "Filter requests with a linked evaluation result. For spans, this is parent-request context, not a claim that each span was independently scored.",
      {
        groupable: false,
        source: "Related parent-request evaluation",
        multiplicity: "many",
        cardinality: "high",
      }
    )
  )
export function relatedEvaluationFields(
  model: string
): Record<string, SqlFilterField> {
  return Object.fromEntries(
    definitions.map(([key, , column]) => [
      `${model}.${key}`,
      {
        value: sql`${traces.id}`,
        type: "string",
        predicate: (filter) => {
          const negative = {
            notEquals: "equals",
            notIn: "in",
            notContains: "contains",
            notSet: "set",
          } as const
          const positive = negative[filter.operator as keyof typeof negative]
          const predicate = semanticSqlFilters(
            [{ ...filter, operator: positive ?? filter.operator }],
            {
              [filter.member]: {
                value: sql.raw(column),
                type: "string",
                caseSensitive: true,
              },
            }
          )
          const exists = sql`exists(select 1 from eval_results e left join dataset_items item on item.project_id=e.project_id and item.id=e.dataset_item_id where e.project_id=${traces.projectId} and e.trace_id=${traces.id} and ${predicate})`
          return positive ? sql`not (${exists})` : exists
        },
      } satisfies SqlFilterField,
    ])
  )
}
