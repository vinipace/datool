import {
  parseFilterQuery,
  validateFilterFields,
} from "@/components/ui/datool/search-bar/filter-query"
import type { SemanticFilter } from "@/src/lib/semantic/query"
import { collectionFilterFields } from "./collection-filters"

const operators = {
  "=": "equals",
  "!=": "notEquals",
  ":": "contains",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
} as const

/** Date clauses are already handled by dashboardFilterScope. */
export function evalQualityExpressionFilters(
  expression: string,
  model = "evalQuality"
): SemanticFilter[] {
  const clauses = parseFilterQuery(expression)
  validateFilterFields(clauses, collectionFilterFields.evalQuality)
  return clauses.map((clause) => {
    if ("text" in clause)
      return {
        member: `${model}.groupName`,
        operator: "contains",
        values: [clause.text],
      }
    return {
      member: `${model}.${clause.path[0]}`,
      operator: operators[clause.operator],
      values: [clause.value],
    }
  })
}
