import { relatedEvaluationMembers } from "./related-evaluation-filters"
import { logsSemanticModel } from "./logs"
import { sourceDimension, sourceMeasures } from "./source-contract"
import {
  defineSemanticModel,
  type SemanticModel,
} from "@/src/lib/semantic/model"
import {
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  METRIC_MODEL_VERSION,
  idFilterOperators,
  labelFilterOperators,
  quality,
} from "./common"
import { executeTracesSql } from "./traces-sql"
import { traceRelationshipMembers } from "@/src/lib/semantic/trace-filters"

export const TRACES_SEMANTIC_MODEL_NAME = "traces" as const
export const TRACES_STARTED_AT = "traces.startedAt" as const
export const TRACES_STATUS = "traces.status" as const
export const TRACES_OPERATION = "traces.operation" as const
export const TRACES_SESSION_ID = "traces.sessionId" as const
const TRACE_LIMITATIONS = [
  "Trace metrics use persisted traces rows only; missing instrumentation cannot be inferred.",
  "Trace duration uses only terminal traces with valid persisted endedAt minus startedAt timestamps. Running traces do not receive a live-clock duration.",
  "Trace duration never sums nested span durations.",
] as const
const COST_LIMITATIONS = [
  "Costs read persisted trace attributes['cost.usd'] once per trace; descendant span totals are not added again. Values may be provider estimates, not invoices.",
  "Missing, invalid, negative, or explicitly partial costs are null. The ranked chart excludes them, so it ranks only traces with complete reported costs.",
] as const
const traceMeasures = [
  {
    aggregation: "ratio",
    basis: "persisted_traces",
    definition:
      "Errored traces divided by completed plus errored traces in the selected startedAt window; null when the denominator is zero. Running and cancelled traces are excluded.",
    description:
      "Failed requests as a share of completed and failed requests. Each trace counts once, regardless of nested span errors.",
    format: "percent",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: "trace-health-v1",
    name: "traces.errorRate",
    title: "Trace failure rate",
    type: "number",
    unit: "ratio",
  },
  {
    aggregation: "sum",
    basis: "persisted_trace_costs",
    definition:
      "Sum of finite nonnegative complete trace cost.usd reports; null when unavailable. Trace totals may be estimated.",
    description:
      "Stored trace cost in USD, including estimates; excludes missing and partial reports.",
    format: "currency",
    currency: "USD",
    kind: "measure",
    limitations: COST_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.reportedCostUsd",
    title: "Reported trace cost",
    type: "number",
    unit: "USD",
  },
  {
    aggregation: "count",
    basis: "persisted_traces",
    definition: "Count of persisted traces.id rows.",
    description: "Trace rows captured in the requested startedAt window.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.count",
    title: "Traces",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "count",
    basis: "persisted_traces",
    definition: "Count of persisted traces with status completed.",
    description: "Traces explicitly persisted as completed.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.completedCount",
    title: "Completed traces",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "count",
    basis: "persisted_traces",
    definition: "Count of persisted traces with status errored.",
    description: "Traces explicitly persisted as errored.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.erroredCount",
    title: "Failed traces",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "count",
    basis: "persisted_traces",
    definition: "Count of persisted traces with status cancelled.",
    description: "Traces explicitly persisted as cancelled.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.cancelledCount",
    title: "Cancelled traces",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "count",
    basis: "persisted_traces",
    definition: "Count of persisted traces with status running.",
    description: "Traces that remain persisted as running.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.runningCount",
    title: "Running traces",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "count",
    basis: "persisted_terminal_traces",
    definition:
      "Count of terminal traces with valid non-negative persisted endedAt minus startedAt durations.",
    description: "Traces included in duration measures.",
    format: "integer",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.durationSampleCount",
    title: "Duration samples",
    type: "number",
    unit: "traces",
  },
  {
    aggregation: "average",
    basis: "persisted_terminal_traces",
    definition:
      "Arithmetic mean of valid terminal trace endedAt minus startedAt durations.",
    description:
      "Mean persisted trace duration; null when no valid terminal duration exists.",
    format: "durationMilliseconds",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.meanDurationMs",
    title: "Mean trace duration",
    type: "number",
    unit: "ms",
  },
  {
    aggregation: "percentile",
    basis: "persisted_terminal_traces",
    definition:
      "Nearest-rank 95th percentile of valid terminal trace endedAt minus startedAt durations.",
    description:
      "Trace duration p95; null when no valid terminal duration exists.",
    format: "durationMilliseconds",
    kind: "measure",
    limitations: TRACE_LIMITATIONS,
    metricVersion: METRIC_MODEL_VERSION,
    name: "traces.p95DurationMs",
    title: "Trace duration p95",
    type: "number",
    unit: "ms",
  },
] as const

export const tracesSemanticModel = defineSemanticModel({
  defaultMeasures: ["traces.count"],
  defaultOrder: [
    [TRACES_STARTED_AT, "asc"],
    [TRACES_OPERATION, "asc"],
    [TRACES_STATUS, "asc"],
  ],
  execute: async (query, context) => {
    const { warnings, ...page } = await executeTracesSql(query, context)
    return { ...page, quality: quality(TRACE_LIMITATIONS, warnings) }
  },
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...relatedEvaluationMembers("traces"),
    ...sourceMeasures(
      "traces",
      [
        [
          "uniqueUserCount",
          "Unique users",
          "countDistinct",
          "users",
          "Distinct recorded user identities; missing identities are excluded.",
        ],
        [
          "uniqueSessionCount",
          "Unique sessions",
          "countDistinct",
          "sessions",
          "Distinct recorded session identities; missing identities are excluded.",
        ],
        [
          "pricedTraceCount",
          "Requests with known LLM cost",
          "count",
          "traces",
          "Requests with at least one eligible child LLM quote, including zero.",
        ],
        [
          "meanLlmCostUsd",
          "Average known LLM cost per request",
          "average",
          "USD",
          "Sum of eligible child LLM quotes divided by requests with at least one quote. Missing quotes remain unknown.",
          "Requests with at least one eligible LLM quote",
        ],
      ],
      "project + trace",
      "Trace start"
    ),
    ...logsSemanticModel.members
      .filter(
        (m) =>
          m.kind === "measure" &&
          [
            "costUsd",
            "inputCostUsd",
            "outputCostUsd",
            "cacheCostUsd",
            "tokenCount",
            "inputTokens",
            "outputTokens",
            "cacheTokens",
            "llmCount",
            "pricedLlmCount",
            "unpricedLlmCount",
            "costCoverage",
          ].includes(m.name.split(".")[1])
      )
      .map((m) => ({
        ...m,
        name: m.name.replace(/^logs[.]/, "traces."),
        factIdentity: "project + trace",
        eventTime: "Trace start",
        attribution:
          "Eligible child LLM spans, including children outside the trace-start window",
        limitations: [
          "Child usage is counted once per selected trace. Related operation groups may overlap. Reported trace cost is separate.",
        ],
      })),
    ...[
      ["agentName", "Agent"],
      ["agentVersion", "Agent version"],
      ["workflowName", "Workflow"],
      ["workflowVersion", "Workflow version"],
      ["model", "LLM model set"],
    ].map(([key, title]) =>
      sourceDimension(
        "traces",
        key,
        title,
        key === "model"
          ? "Child LLM model set: one model, Multiple models, or Unknown."
          : "Recorded trace membership. A trace can belong to several operations; grouped counts and costs can overlap.",
        {
          multiplicity: key === "model" ? "one" : "many",
          source: "Recorded trace membership",
          overlap: "Related operation groups overlap; do not sum groups.",
        }
      )
    ),
    ...traceMeasures,
    ...[
      [
        "traceName",
        "Trace name",
        "Exact persisted trace name; repeated requests with the same name are grouped together.",
      ],
      [
        "userId",
        "User ID",
        "Recorded trace attributes user.id, enduser.id or userId, in that order. Missing identities remain null; these are instrumented users, not workspace members.",
      ],
    ].map(([key, title, definition]) => ({
      name: `traces.${key}`,
      kind: "dimension" as const,
      type: "string" as const,
      title,
      description: definition,
      definition,
      filterOperators: labelFilterOperators,
      groupable: true,
      metricVersion: "trace-health-v1",
    })),
    ...traceRelationshipMembers("traces", METRIC_MODEL_VERSION),
    {
      name: "traces.trace",
      title: "Trace",
      kind: "dimension",
      type: "string",
      groupable: true,
      description: "Individual trace name and unique ID.",
      definition:
        "Persisted traces.name and full traces.id; equal names remain separate traces.",
      filterOperators: labelFilterOperators,
      metricVersion: METRIC_MODEL_VERSION,
    },
    {
      name: "traces.hasReportedCost",
      title: "Has complete reported cost",
      kind: "dimension",
      type: "string",
      groupable: false,
      description:
        "Whether the trace has a finite nonnegative complete USD cost report.",
      definition:
        "Yes when trace cost.usd is valid and cost.status is neither missing nor partial.",
      filterOperators: ["equals", "notEquals"],
      metricVersion: METRIC_MODEL_VERSION,
    },
    {
      definition:
        "The persisted traces.startedAt timestamp used for calendar bucketing.",
      description:
        "Trace start instant used for the requested half-open time window.",
      granularities: ["day", "week", "month"],
      kind: "timeDimension",
      limitations: TRACE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: TRACES_STARTED_AT,
      title: "Started at",
      type: "date",
    },
    {
      definition: "The persisted traces.status lifecycle value.",
      description: "Trace lifecycle status.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: TRACE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: TRACES_STATUS,
      title: "Status",
      type: "string",
    },
    {
      definition: "The persisted traces.operation value.",
      description: "Instrumented trace operation.",
      filterOperators: labelFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: TRACE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: TRACES_OPERATION,
      title: "Operation",
      type: "string",
    },
    {
      definition: "The persisted traces.sessionId foreign key when present.",
      description: "Session ID for narrowing trace facts.",
      filterOperators: idFilterOperators,
      groupable: true,
      kind: "dimension",
      limitations: TRACE_LIMITATIONS,
      metricVersion: METRIC_MODEL_VERSION,
      name: TRACES_SESSION_ID,
      title: "Session ID",
      type: "string",
    },
  ],
  name: TRACES_SEMANTIC_MODEL_NAME,
  version: METRIC_MODEL_VERSION,
} satisfies SemanticModel)
