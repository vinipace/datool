import {
  relatedEvaluationMembers,
  relatedEvaluationFields,
} from "./related-evaluation-filters"
import { sql } from "drizzle-orm"
import { defineSemanticModel } from "@/src/lib/semantic/model"
import { traceRelationshipMembers } from "@/src/lib/semantic/trace-filters"
import { spans, traces } from "@/src/server/tracer/schema"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { logsSemanticModel } from "./logs"
import { aggregateSql, lifecycleMeasures, sqlDay } from "./aggregate-sql"
import { costAttributionSql } from "./cost-attribution-sql"
import { traceSqlFields } from "./trace-fields"
import { llmFactColumns, llmAggregates, recordedModelSql } from "./llm-facts"
import {
  metricWindow,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
} from "./common"
import {
  sourceDimension,
  sourceMeasures,
  sourceTime,
  metadataDimension,
} from "./source-contract"

const limitations = [
  "Span-start population. Request duration and reported trace cost are separate metrics in Traces.",
  "Missing usage/cost is unknown, including partial quotes; a recorded zero is included.",
  "Execution role requires recorded markers; scorer descendants inherit scorer role. Unmarked spans remain Unknown.",
]
const legacyMembers = logsSemanticModel.members.filter(
  (m) =>
    !["logs.meanLatencyMs", "logs.p95LatencyMs", "logs.startedAt"].includes(
      m.name
    ) &&
    !m.name.includes(".parent.") &&
    m.name !== "logs.invocationGroup"
)
export const spansSemanticModel = defineSemanticModel({
  name: "spans",
  version: "v1",
  defaultMeasures: ["spans.spanCount"],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...relatedEvaluationMembers("spans"),
    ...legacyMembers.map((m) => ({
      ...m,
      name: m.name.replace(/^logs[.]/, "spans."),
      factIdentity: "project + trace + span",
      eventTime: "Span start",
      definition: m.definition
        .replaceAll("logs.", "spans.")
        .replace(" Cannot group or filter trace latency.", ""),
      description: m.description.replace(
        " Cannot group or filter trace latency.",
        ""
      ),
    })),
    ...sourceMeasures(
      "spans",
      [
        [
          "completedCount",
          "Completed spans",
          "count",
          "spans",
          "Spans persisted as completed.",
        ],
        [
          "runningCount",
          "Running spans",
          "count",
          "spans",
          "Spans persisted as running.",
        ],
        [
          "cancelledCount",
          "Cancelled spans",
          "count",
          "spans",
          "Spans persisted as cancelled.",
        ],
        [
          "durationSampleCount",
          "Span duration samples",
          "count",
          "spans",
          "Terminal spans with valid persisted duration.",
        ],
        [
          "meanDurationMs",
          "Average span duration",
          "average",
          "ms",
          "Arithmetic mean of terminal span durations, including zero.",
          "Terminal spans with a valid duration",
        ],
        [
          "p95DurationMs",
          "P95 span duration",
          "percentile",
          "ms",
          "Nearest-rank P95 of terminal span durations.",
        ],
        [
          "ttftSampleCount",
          "Time to first token samples",
          "count",
          "spans",
          "LLM spans with instrumented time to first token.",
        ],
      ],
      "project + trace + span",
      "Span start"
    ),
    ...[
      ["id", "Span ID"],
      ["traceId", "Trace ID"],
      ["kind", "Span kind"],
      ["provider", "LLM provider"],
      ["sessionId", "Session"],
      ["userId", "User"],
      ["agentVersion", "Agent version"],
      ["workflowVersion", "Workflow version"],
      ["executionRole", "Execution role"],
    ].map(([key, title]) =>
      sourceDimension(
        "spans",
        key,
        title,
        key === "executionRole"
          ? limitations[2]
          : `Recorded ${title.toLowerCase()}; missing values remain Unknown.`
      )
    ),
    metadataDimension(
      "spans",
      "metadata",
      "Span metadata",
      "Typed paths in recorded span attributes. Parent trace attributes are a separate filter."
    ),
    ...traceRelationshipMembers("spans", "v1"),
    sourceTime(
      "spans",
      "startedAt",
      "Started at",
      "Span start in the requested timezone."
    ),
  ],
  execute: async (query, context) => {
    const window = metricWindow(query, "spans.startedAt")
    const attribution = costAttributionSql(query, "spans")
    const text = (value: ReturnType<typeof sql>): SqlFilterField => ({
      value,
      type: "string",
      caseSensitive: true,
    })
    const fields: Record<string, SqlFilterField> = {
      ...relatedEvaluationFields("spans"),
      ...traceSqlFields("spans"),
      ...attribution.fields,
      "spans.id": text(sql`${spans.id}`),
      "spans.traceId": text(sql`${spans.traceId}`),
      "spans.trace": text(sql`${traces.name} || ' · ' || ${traces.id}`),
      "spans.traceName": text(sql`${traces.name}`),
      "spans.spanName": text(sql`${spans.name}`),
      "spans.spanStatus": text(sql`${spans.status}`),
      "spans.kind": text(sql`${spans.kind}`),
      "spans.model": text(recordedModelSql),
      "spans.provider": text(
        sql`coalesce(nullif(${spans.attributesJson}->>'gen_ai.provider.name',''),nullif(${spans.attributesJson}->>'gen_ai.system',''),nullif(${spans.attributesJson}->>'ai.model.provider',''))`
      ),
      "spans.userId": text(
        sql`coalesce(${traces.attributesJson}->>'user.id',${traces.attributesJson}->>'enduser.id',${traces.attributesJson}->>'userId')`
      ),
      "spans.sessionId": text(sql`${traces.sessionId}`),
      "spans.errorType": text(
        sql`coalesce(${spans.attributesJson}->>'error.type',${spans.attributesJson}->>'error.name',${spans.attributesJson}->>'exception.type')`
      ),
      "spans.errorMessage": text(
        sql`coalesce(${spans.attributesJson}->>'error.message',${spans.attributesJson}->>'exception.message')`
      ),
      "spans.hasCost": text(
        sql`case when ${spans.kind}='llm' and ${spans.costUsd} is not null then 'yes' else 'no' end`
      ),
      "spans.spanCostUsd": {
        value: sql`case when ${spans.kind}='llm' then ${spans.costUsd} end`,
        type: "number",
      },
      "spans.metadata": {
        value: sql`${spans.attributesJson}`,
        type: "json",
        nativeJson: true,
      },
    }
    const facts = sql`select ${spans.status} as status, ${spans.kind} as kind,
      case when ${spans.status} in ('completed','errored','cancelled') and ${spans.endedAtMs} >= ${spans.startedAtMs} then ${spans.endedAtMs}-${spans.startedAtMs} end as duration,
      case when ${spans.kind}='llm' then ${spans.ttftMs} end as ttft,
      ${sql.join(
        Object.entries(llmFactColumns).map(
          ([key, value]) =>
            sql`case when ${spans.kind}='llm' then ${value} end as ${sql.identifier(key)}`
        ),
        sql`, `
      )},
      ${sqlDay(query, "spans.startedAt", sql`${spans.startedAtMs}`)} as "spans.startedAt"
      ${
        query.dimensions.length
          ? sql`, ${sql.join(
              query.dimensions.map(
                (d) => sql`${fields[d].value} as ${sql.identifier(d)}`
              ),
              sql`, `
            )}`
          : sql``
      }
      from ${spans} join ${traces} on ${traces.projectId}=${spans.projectId} and ${traces.id}=${spans.traceId}
      ${attribution.join}
      where ${spans.projectId}=${context.snapshot.projectId} and ${spans.startedAtMs}>=${window.fromMs} and ${spans.startedAtMs}<${window.toMs}
      and ${semanticSqlFilters(query.filters, fields)}`
    const { warnings, ...page } = await aggregateSql(
      query,
      context,
      facts,
      "spans.startedAt",
      {
        ...llmAggregates,
        ...lifecycleMeasures(["completed", "running", "cancelled", "errored"]),
        spanCount: sql`count(*)`,
        toolCount: sql`count(*) filter(where kind='tool')`,
        otherCount: sql`count(*) filter(where kind not in ('llm','tool'))`,
        errorRate: sql`count(*) filter(where status='errored')::double precision/nullif(count(*) filter(where status in ('completed','errored')),0)`,
        durationSampleCount: sql`count(duration)`,
        meanDurationMs: sql`avg(duration)`,
        p95DurationMs: sql`percentile_disc(0.95) within group(order by duration)`,
        ttftSampleCount: sql`count(ttft)`,
        meanTtftMs: sql`avg(ttft)`,
        p95TtftMs: sql`percentile_disc(0.95) within group(order by ttft)`,
      },
      [],
      {},
      true
    )
    return { ...page, quality: quality(limitations, warnings) }
  },
})
