import {
  defineSemanticModel,
  type SemanticMeasureAggregation,
  type SemanticMemberDefinition,
} from "@/src/lib/semantic/model"
import {
  labelFilterOperators,
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
} from "./common"
import { executePerformanceSql } from "./performance-sql"
import { invocationFilterMember } from "@/src/lib/semantic/group-filter"
const LIMITATIONS = [
  "Membership uses explicit persisted group type, name and nullable version, independently of operation kind. Counts represent member trace/span operations, not workflow executions.",
  "Names identify instrumented entities. Changing a name creates a separate performance group; names are case-sensitive.",
  "Error rate is errored / (completed + errored). Running and cancelled invocations are shown separately and excluded from this denominator.",
  "Latency uses valid persisted end minus start for completed or errored invocations, never the sum of child durations.",
  "Cost is reported USD from attributes['cost.usd']. An invocation's reported cost includes its descendants and overrides their costs. Otherwise descendant costs are summed, skipping children of a reported aggregate. Missing LLM cost makes coverage partial. No provider prices are inferred.",
  "Reported cost includes running invocations and partial reports. Costs of nested named invocations overlap across rows; do not sum rows as a workspace billing total.",
] as const

const measureDefinitions: {
  key: string
  title: string
  aggregation: SemanticMeasureAggregation
  definition: string
  unit?: string
}[] = [
  {
    key: "count",
    title: "Operations",
    aggregation: "count",
    definition:
      "Count of explicitly grouped trace/span operations in the start-time window, not distinct workflow executions.",
  },
  {
    key: "versionCount",
    title: "Versions",
    aggregation: "countDistinct",
    definition:
      "Distinct non-null recorded group versions among matching operations in the start-time window. Unversioned operations contribute to other metrics but not this count.",
  },
  {
    key: "completedCount",
    title: "Completed",
    aggregation: "count",
    definition: "Invocations with status completed.",
  },
  {
    key: "erroredCount",
    title: "Errors",
    aggregation: "count",
    definition: "Invocations with status errored.",
  },
  {
    key: "runningCount",
    title: "Running",
    aggregation: "count",
    definition: "Invocations with status running.",
  },
  {
    key: "cancelledCount",
    title: "Cancelled",
    aggregation: "count",
    definition: "Invocations with status cancelled.",
  },
  {
    key: "errorRate",
    title: "Error rate",
    aggregation: "ratio",
    definition:
      "Errored divided by completed plus errored; null when the denominator is zero.",
  },
  {
    key: "meanDurationMs",
    title: "Average latency",
    aggregation: "average",
    unit: "ms",
    definition:
      "Mean valid end minus start duration of completed and errored invocations.",
  },
  {
    key: "p95DurationMs",
    title: "P95 latency",
    aggregation: "percentile",
    unit: "ms",
    definition:
      "Nearest-rank 95th percentile of valid completed and errored invocation durations.",
  },
  {
    key: "durationSampleCount",
    title: "Latency samples",
    aggregation: "count",
    definition: "Number of valid durations used in latency measures.",
  },
  {
    key: "reportedCostUsd",
    title: "Reported cost",
    aggregation: "sum",
    unit: "USD",
    definition:
      "Sum of available inclusive invocation costs, including partial and running reports; null when no cost is reported.",
  },
  {
    key: "costSampleCount",
    title: "Cost reports",
    aggregation: "count",
    definition:
      "Invocations with at least one valid cost report, including partial reports.",
  },
  {
    key: "completeCostCount",
    title: "Complete cost reports",
    aggregation: "count",
    definition:
      "Invocations with a valid cost report and no missing descendant LLM cost after inclusive-total pruning.",
  },
]

function performanceModel(
  model: "agents" | "workflows",
  kind: "agent" | "workflow"
) {
  const member = (key: string) => `${model}.${key}`
  const members: SemanticMemberDefinition[] = [
    invocationFilterMember(model, "v1"),
    {
      name: member("fullText"),
      title: "Full text",
      description: "Search invocation names and versions.",
      definition: "Case-insensitive substring matching of name or version before aggregation.",
      kind: "dimension",
      type: "string",
      filterOperators: ["contains"],
      groupable: false,
      metricVersion: "v1",
    },
    ...measureDefinitions.map((measure) => ({
      name: member(measure.key),
      title: measure.title,
      description: measure.definition,
      definition: measure.definition,
      kind: "measure" as const,
      type: "number" as const,
      aggregation: measure.aggregation,
      metricVersion: "v2",
      limitations: LIMITATIONS,
      ...(measure.unit ? { unit: measure.unit } : {}),
      ...(measure.unit === "USD" ? { currency: "USD", estimated: false } : {}),
    })),
    ...["name", "version", "traceId", "invocationId", "source", "status"]
      .map(member)
      .map((name) => ({
        name,
        title: name.split(".")[1],
        description: `Instrumented ${kind} ${name.split(".")[1]}.`,
        definition:
          name === member("name")
            ? `Explicit persisted group name.`
            : `Persisted invocation ${name.split(".")[1]}.`,
        kind: "dimension" as const,
        type: "string" as const,
        filterOperators: labelFilterOperators,
        groupable: true,
        metricVersion: "v2",
      })),
    {
      name: member("startedAt"),
      title: "Started at",
      description: "Invocation start time.",
      definition: "Persisted startedAt in the half-open requested time window.",
      kind: "timeDimension",
      type: "date",
      granularities: ["day"],
      metricVersion: "v2",
    },
  ]
  return defineSemanticModel({
    name: model,
    version: "v2",
    members,
    maxLimit: METRIC_MAX_LIMIT,
    maxWindowDays: METRIC_MAX_WINDOW_DAYS,
    defaultMeasures: [member("count")],
    async execute(query, context) {
      const { warnings, ...page } = await executePerformanceSql(
        model,
        kind,
        query,
        context
      )
      return { ...page, quality: quality(LIMITATIONS, warnings) }
    },
  })
}
export const agentsSemanticModel = performanceModel("agents", "agent")
export const workflowsSemanticModel = performanceModel("workflows", "workflow")
