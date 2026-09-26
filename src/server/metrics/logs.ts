import {
  defineSemanticModel,
  type SemanticMeasureAggregation,
  type SemanticMemberDefinition,
} from "@/src/lib/semantic/model"
import { traceRelationshipMembers } from "@/src/lib/semantic/trace-filters"
import {
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  quality,
  labelFilterOperators,
} from "./common"
import { executeLogsSql } from "./logs-sql"

const version = "logs-v4"
const limitations = [
  "Failed spans count each persisted span with status errored, including nested calls and recovered retries. Use traces.erroredCount for failed requests. Span error rate excludes running and cancelled spans.",
  "Counts use persisted spans of matching traces. Usage and costs count only LLM spans; parent trace aggregates are not added again.",
  "Latency uses persisted terminal trace duration. TTFT requires an explicit span ttft.ms, latency.ttft_ms, ai.response.msToFirstChunk, ai.stream.msToFirstChunk (milliseconds), or gen_ai.latency.time_to_first_token (seconds). Missing timings and costs remain null.",
  "Cost breakdowns use persisted ingestion quotes, without repricing. Only finite nonnegative cost quotes not marked missing or partial are eligible. Totals and trace rankings share this rule; estimates remain estimates.",
  "Function, agent, workflow, and step dimensions attribute each span to its nearest matching context. Each LLM cost belongs to one row per dimension, so nested groups do not duplicate spend. Missing context stays unattributed. Ancestry can precede the selected time window.",
]
const specs: {
  key: string
  title: string
  unit: string
  aggregation: SemanticMeasureAggregation
  definition: string
}[] = [
  {
    key: "pricedLlmCount",
    title: "Priced LLM calls",
    unit: "spans",
    aggregation: "count",
    definition:
      "LLM spans with an eligible complete cost quote, including measured zero cost.",
  },
  {
    key: "unpricedLlmCount",
    title: "Unpriced LLM calls",
    unit: "spans",
    aggregation: "count",
    definition:
      "LLM spans without an eligible complete cost quote; missing cost is never treated as zero.",
  },
  {
    key: "costCoverage",
    title: "Cost coverage",
    unit: "ratio",
    aggregation: "ratio",
    definition:
      "Priced LLM calls divided by all LLM calls; null without LLM calls. This is call coverage, not a share of spend.",
  },
  {
    key: "meanLlmCostUsd",
    title: "Average cost per priced LLM call",
    unit: "USD",
    aggregation: "average",
    definition:
      "Eligible LLM cost divided by priced LLM calls. Unpriced calls are excluded from both numerator and denominator.",
  },
  {
    key: "spanCount",
    title: "Total spans",
    unit: "spans",
    aggregation: "count",
    definition:
      "Count of all persisted spans in the selected time window and matching traces.",
  },
  {
    key: "erroredCount",
    title: "Failed spans",
    unit: "spans",
    aggregation: "count",
    definition:
      "Count of spans with status errored in the selected period. Includes nested failures and recovered retries; not a count of failed traces.",
  },
  {
    key: "errorRate",
    title: "Span error rate",
    unit: "ratio",
    aggregation: "ratio",
    definition:
      "Failed spans divided by completed plus failed spans in the selected period. Running and cancelled spans are excluded; null without completed or failed spans.",
  },
  {
    key: "llmCount",
    title: "LLM calls",
    unit: "spans",
    aggregation: "count",
    definition: "Count of spans with kind llm.",
  },
  {
    key: "toolCount",
    title: "Tool calls",
    unit: "spans",
    aggregation: "count",
    definition: "Count of spans with kind tool.",
  },
  {
    key: "otherCount",
    title: "Other spans",
    unit: "spans",
    aggregation: "count",
    definition: "Count of spans with kinds other than llm and tool.",
  },
  {
    key: "meanLatencyMs",
    title: "Average trace latency",
    unit: "ms",
    aggregation: "average",
    definition:
      "Arithmetic mean of valid persisted terminal trace durations; null without samples.",
  },
  {
    key: "p95LatencyMs",
    title: "P95 trace latency",
    unit: "ms",
    aggregation: "percentile",
    definition: "Nearest-rank p95 of valid persisted terminal trace durations.",
  },
  {
    key: "costUsd",
    title: "Total LLM cost",
    unit: "USD",
    aggregation: "sum",
    definition: "Sum of available LLM span cost.usd values; null if none.",
  },
  {
    key: "inputCostUsd",
    title: "Uncached input cost",
    unit: "USD",
    aggregation: "sum",
    definition: "Sum of stored cost.breakdown.inputUSD.",
  },
  {
    key: "outputCostUsd",
    title: "Output cost",
    unit: "USD",
    aggregation: "sum",
    definition: "Sum of stored cost.breakdown.outputUSD.",
  },
  {
    key: "cacheCostUsd",
    title: "Cache cost",
    unit: "USD",
    aggregation: "sum",
    definition:
      "Sum of available stored cacheReadsUSD and cacheWritesUSD cost components.",
  },
  {
    key: "tokenCount",
    title: "Total tokens",
    unit: "tokens",
    aggregation: "sum",
    definition: "Sum of available LLM span total token usage; null if none.",
  },
  {
    key: "inputTokens",
    title: "Uncached input tokens",
    unit: "tokens",
    aggregation: "sum",
    definition:
      "LLM input tokens minus reported cache-read and cache-write tokens, never negative.",
  },
  {
    key: "outputTokens",
    title: "Output tokens",
    unit: "tokens",
    aggregation: "sum",
    definition:
      "Available LLM output tokens, including reasoning tokens already in output.",
  },
  {
    key: "cacheTokens",
    title: "Cached input tokens",
    unit: "tokens",
    aggregation: "sum",
    definition: "LLM cache-read plus cache-write tokens, when reported.",
  },
  {
    key: "meanTtftMs",
    title: "Average time to first token",
    unit: "ms",
    aggregation: "average",
    definition:
      "Mean explicitly instrumented LLM time to first token; null when unavailable.",
  },
  {
    key: "p95TtftMs",
    title: "P95 time to first token",
    unit: "ms",
    aggregation: "percentile",
    definition:
      "Nearest-rank p95 of explicitly instrumented time to first token.",
  },
]
export const logsSemanticModel = defineSemanticModel({
  name: "logs",
  version,
  defaultMeasures: ["logs.spanCount"],
  defaultOrder: [["logs.startedAt", "asc"]],
  maxLimit: METRIC_MAX_LIMIT,
  maxWindowDays: METRIC_MAX_WINDOW_DAYS,
  members: [
    ...specs.map(
      (spec) =>
        ({
          name: `logs.${spec.key}`,
          kind: "measure",
          type: "number",
          title: spec.title,
          description: spec.definition,
          definition: spec.definition,
          unit: spec.unit,
          format:
            spec.unit === "ratio"
              ? "percent"
              : spec.unit === "USD"
                ? "currency"
                : spec.unit === "ms"
                  ? "durationMilliseconds"
                  : "integer",
          ...(spec.unit === "USD" ? { currency: "USD" } : {}),
          aggregation: spec.aggregation,
          metricVersion: version,
          limitations,
        }) satisfies SemanticMemberDefinition
    ),
    {
      name: "logs.startedAt",
      kind: "timeDimension",
      type: "date",
      title: "Started at",
      description: "Persisted start time, bucketed by day.",
      definition: "Span start for span metrics; trace start for trace latency.",
      granularities: ["day"],
      metricVersion: version,
    },
    ...traceRelationshipMembers("logs", version),
    ...[
      [
        "functionName",
        "LLM call name",
        "Application operation recorded for an LLM call, resolved from its telemetry function ID or nearest named function or agent. SDK wrapper names are skipped. Missing identity remains null.",
      ],
      [
        "agentName",
        "Agent",
        "Nearest explicit agent membership on the span, its ancestors, or the trace. Each span belongs to at most one displayed agent; missing membership remains null.",
      ],
      [
        "workflowName",
        "Workflow",
        "Nearest explicit workflow membership on the span, its ancestors, or the trace. Each span belongs to at most one displayed workflow; use trace name to select the enclosing request.",
      ],
      [
        "stepName",
        "Step",
        "Nearest recorded task span, including the selected span itself. Missing task ancestry remains null.",
      ],
    ].map(([key, title, definition]) => ({
      name: `logs.${key}`,
      kind: "dimension" as const,
      type: "string" as const,
      title,
      description: definition,
      definition,
      filterOperators: labelFilterOperators,
      groupable: true,
      metricVersion: version,
    })),
    ...[
      [
        "model",
        "LLM model",
        "Recorded span model: gen_ai.response.model, ai.response.model, gen_ai.request.model, ai.model.id, then model. Response model takes precedence; missing model remains null. Cannot group or filter trace latency.",
      ],
      [
        "spanStatus",
        "Span status",
        "The persisted span lifecycle status, independently of its parent trace's status.",
      ],
      [
        "errorType",
        "Error type",
        "Recorded error.type, error.name or exception.type, in that order. Missing types remain null.",
      ],
      [
        "errorMessage",
        "Error message",
        "Recorded error.message or exception.message. Exact messages are grouped together; missing messages remain null.",
      ],
    ].map(([key, title, definition]) => ({
      name: `logs.${key}`,
      kind: "dimension" as const,
      type: "string" as const,
      title,
      description: definition,
      definition,
      filterOperators: labelFilterOperators,
      groupable: true,
      metricVersion: version,
    })),
    {
      name: "logs.spanName",
      kind: "dimension",
      type: "string",
      title: "Span name",
      description: "Span name, combining repeated calls with the same name.",
      definition:
        "Group selected span facts by their exact persisted name across traces. Cannot group or filter trace latency.",
      filterOperators: labelFilterOperators,
      groupable: true,
      metricVersion: version,
    },
    {
      name: "logs.traceName",
      kind: "dimension",
      type: "string",
      title: "Trace name",
      description:
        "Parent trace name, combining repeated calls with the same name.",
      definition:
        "Group selected span facts by the exact persisted parent trace name, without its unique ID.",
      filterOperators: labelFilterOperators,
      groupable: true,
      metricVersion: version,
    },
    {
      name: "logs.trace",
      kind: "dimension",
      type: "string",
      title: "Trace",
      description: "Parent trace name and unique ID.",
      definition: "Group selected span facts by parent trace identity.",
      filterOperators: labelFilterOperators,
      metricVersion: version,
    },
    {
      name: "logs.hasCost",
      kind: "dimension",
      type: "string",
      title: "Has eligible LLM cost",
      description: "Select LLM spans with an eligible cost quote.",
      definition: "Uses the same cost eligibility as logs.costUsd.",
      filterOperators: ["equals", "notEquals"],
      groupable: false,
      metricVersion: version,
    },
    {
      name: "logs.spanCostUsd",
      kind: "dimension",
      type: "number",
      title: "LLM span cost (USD)",
      description:
        "Filter eligible LLM span costs before aggregation; greater than zero hides zero-cost groups.",
      definition:
        "The same finite nonnegative complete LLM cost quote used by logs.costUsd; null for other spans and unavailable costs.",
      filterOperators: [
        "equals",
        "notEquals",
        "gt",
        "gte",
        "lt",
        "lte",
        "set",
        "notSet",
      ],
      groupable: false,
      metricVersion: version,
    },
  ],
  execute: async (query, context) => ({
    ...(await executeLogsSql(query, context)),
    quality: quality(limitations, []),
  }),
})
