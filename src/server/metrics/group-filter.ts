import { sql, type SQL } from "drizzle-orm"
import { invocationSelectionSchema } from "@/src/lib/semantic/group-filter"
import { SemanticModelQueryError } from "@/src/lib/semantic/model"
import type { SqlFilterField } from "@/src/server/semantic/sql-filters"

/** EXISTS keeps multiple matching invocations from multiplying metric facts. */
export function invocationSqlField(
  project: SQL,
  trace: SQL,
  ownType?: "agent" | "workflow"
): SqlFilterField {
  return {
    type: "string",
    value: trace,
    predicate(filter) {
      if (
        !["equals", "in"].includes(filter.operator) ||
        !filter.values?.length ||
        filter.path
      )
        throw new SemanticModelQueryError(
          "MODEL_QUERY_INVALID",
          "Invocation groups require equals or in with group selections."
        )
      const selections = filter.values.map((value) => {
        try {
          return invocationSelectionSchema.parse(JSON.parse(String(value)))
        } catch {
          throw new SemanticModelQueryError(
            "MODEL_QUERY_INVALID",
            "Invalid invocation group selection."
          )
        }
      })
      return sql`(${sql.join(
        selections.map((selection) => {
          const own = selection.type === ownType
          const name = own
            ? sql`invocations.group_name`
            : sql`membership.group_name`
          const version = own
            ? sql`invocations.group_version`
            : sql`membership.group_version`
          const predicate = sql`${name} = ${selection.name} ${
            selection.versions
              ? sql`and (${sql.join(
                  selection.versions.map(
                    (v) => sql`${version} is not distinct from ${v}::text`
                  ),
                  sql` or `
                )})`
              : sql``
          }`
          return own
            ? sql`(${predicate})`
            : sql`exists (select 1 from trace_group_memberships membership where membership.project_id = ${project} and membership.trace_id = ${trace} and membership.group_type = ${selection.type} and ${predicate})`
        }),
        sql` or `
      )})`
    },
  }
}
