import {
  matchesFilter,
  parseFilterQuery,
  validateFilterFields,
} from "@/components/ui/datool/search-bar/filter-query"
import type { SearchFieldSpec } from "@/components/ui/datool/search-bar/search-core"

const text = (id: string): SearchFieldSpec => ({ id, kind: "text" })
const number = (id: string): SearchFieldSpec => ({ id, kind: "number" })
const json = (id: string): SearchFieldSpec => ({ id, kind: "json" })
const date = (id: string): SearchFieldSpec => ({ id, kind: "date" })

/** Shared editor fields and validation; consumers apply the predicate to their collection. */
export const collectionFilterFields = {
  alerts: [
    text("id"),
    text("name"),
    text("description"),
    text("filter"),
    { id: "status", kind: "enum", options: ["enabled", "paused"] },
    { id: "type", kind: "enum", options: ["log_event", "time_window"] },
    { id: "action", kind: "enum", options: ["in_app", "webhook"] },
    date("createdAt"),
    date("lastNotifiedAt"),
    text("lastError"),
  ],
  alertNotifications: [
    text("id"),
    text("traceName"),
    text("lastError"),
    {
      id: "status",
      kind: "enum",
      options: ["pending", "delivered", "failed", "cancelled"],
    },
    { id: "action", kind: "enum", options: ["in_app", "webhook"] },
    number("attempts"),
    number("matchCount"),
    date("createdAt"),
  ],
  reviews: [
    text("id"), text("name"), text("assigneeName"),
    { id: "status", kind: "enum", options: ["pending", "in_progress", "completed"] },
    number("traceCount"), number("reviewedCount"), date("createdAt"),
  ],
  prompts: [text("id"), text("name"), text("slug"), text("description"), text("model"), number("revision"), number("publishedVersion"), date("createdAt"), date("updatedAt")],
  scorers: [
    text("id"),
    text("name"),
    text("slug"),
    text("description"),
    { id: "type", kind: "enum", options: ["llm", "javascript", "python", "library"] },
    number("revision"),
    date("createdAt"),
    date("updatedAt"),
  ],
  datasetItems: [text("id"), json("input"), json("expectedOutput"), json("metadata"), text("sourceTraceId"), date("createdAt"), date("updatedAt")],
  agents: [text("name"), text("version"), date("startedAt")],
  workflows: [text("name"), text("version"), date("startedAt")],
  evalQuality: [
    date("startedAt"),
    text("workflow"),
    text("agent"),
    { ...text("groupName"), label: "Operation name" },
    { id: "groupType", label: "Operation type", kind: "enum", options: ["workflow", "agent"] },
    { ...text("groupVersion"), label: "Operation version" },
    text("model"),
    text("evaluatorName"),
    text("evaluatorVersion"),
    text("evaluatorId"),
    text("runId"),
  ],
  traces: [
    text("traceOrSpanName"),
    text("functionName"),
    text("id"),
    text("name"),
    text("operation"),
    text("groupType"),
    text("groupName"),
    text("groupVersion"),
    text("sessionId"),
    {
      id: "status",
      kind: "enum",
      options: ["running", "completed", "errored", "cancelled"],
    },
    json("metadata"),
    json("attributes"),
    json("input"),
    json("output"),
    json("metrics"),
    number("durationMs"),
    date("startedAt"),
    date("endedAt"),
  ],
  evals: [
    date("groupsResolvedAt"),
    text("id"),
    text("name"),
    json("groups"),
    text("workflow"),
    text("agent"),
    text("datasetId"),
    {
      id: "status",
      kind: "enum",
      options: ["partial", "running", "completed", "failed"],
    },
    json("metadata"),
    number("score"),
    number("resultCount"),
    date("createdAt"),
    date("completedAt"),
  ],
  sessions: [
    text("id"),
    text("name"),
    json("metadata"),
    json("attributes"),
    number("traceCount"),
    date("createdAt"),
    date("updatedAt"),
  ],
} satisfies Record<string, SearchFieldSpec[]>

export type FilterResource = keyof typeof collectionFilterFields

export function compileCollectionFilter(
  resource: FilterResource,
  query = "",
  now = Date.now()
) {
  const fields = collectionFilterFields[resource]
  const clauses = parseFilterQuery(query)
  validateFilterFields(clauses, fields)
  return (record: object) => {
    const row = record as Record<string, unknown>
    const attributes = row.attributes as Record<string, unknown> | undefined
    return matchesFilter(
      {
        ...row,
        metadata: resource === "evals" || resource === "datasetItems" ? row.metadata : attributes,
        metrics: attributes?.metrics,
      },
      clauses,
      fields,
      now
    )
  }
}
