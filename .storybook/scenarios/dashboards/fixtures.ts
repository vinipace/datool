import { traceRelationshipMembers } from "@/src/lib/semantic/trace-filters"
import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import type { SemanticMemberDefinition } from "@/src/lib/semantic/model"
import {
  semanticQuerySchema,
  type NormalizedSemanticQuery,
  type SemanticMemberName,
} from "@/src/lib/semantic/query"
import {
  semanticResultSchema,
  type SemanticDataRow,
  type SemanticMemberAnnotation,
  type SemanticResult,
} from "@/src/lib/semantic/result"
import type { Dashboard, DashboardWidget } from "@/src/lib/tracer/dashboards"
import {
  performanceMeasures,
  type PerformanceModel,
} from "@/src/lib/tracer/performance-table"

export const dashboardDates = {
  asOf: "2026-09-11T12:00:00.000Z",
  from: "2026-09-08T00:00:00.000Z",
  to: "2026-09-11T00:00:00.000Z",
} as const

const metricVersion = "storybook-v1"
const member = (value: string) => value as SemanticMemberName

function titleFor(memberName: string) {
  const titles: Record<string, string> = {
    "traces.count": "Traces",
    "traces.errorRate": "Error rate",
    "traces.erroredCount": "Errored traces",
    "traces.operation": "Operation",
    "traces.trace": "Trace",
    "traces.startedAt": "Started at",
    "logs.spanCount": "Spans",
    "logs.erroredCount": "Failed spans",
    "logs.errorRate": "Span error rate",
    "logs.llmCount": "LLM spans",
    "logs.otherCount": "Other spans",
    "logs.toolCount": "Tool spans",
    "logs.p95LatencyMs": "P95 latency",
    "logs.meanLatencyMs": "Average latency",
    "logs.costUsd": "Total LLM cost",
    "logs.inputCostUsd": "Input cost",
    "logs.outputCostUsd": "Output cost",
    "logs.cacheCostUsd": "Cache cost",
    "logs.tokenCount": "Tokens",
    "logs.inputTokens": "Input tokens",
    "logs.outputTokens": "Output tokens",
    "logs.cacheTokens": "Cache tokens",
    "logs.p95TtftMs": "P95 time to first token",
    "logs.meanTtftMs": "Average time to first token",
    "logs.startedAt": "Started at",
  }
  return (
    titles[memberName] ??
    memberName
      .split(".")
      .at(-1)!
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (letter) => letter.toUpperCase())
  )
}

function measureAggregation(memberName: string) {
  if (memberName.endsWith("Rate")) return "ratio" as const
  if (memberName.endsWith("Count")) return "count" as const
  if (memberName.includes("Latency") || memberName.includes("Duration"))
    return "average" as const
  return "sum" as const
}

function measureAnnotation(memberName: string): SemanticMemberAnnotation {
  const annotation: SemanticMemberAnnotation = {
    name: member(memberName),
    kind: "measure",
    type: "number",
    title: titleFor(memberName),
    description: `Storybook fixture for ${titleFor(memberName)}.`,
    metricVersion,
    definition: `Deterministic ${titleFor(memberName)} fixture value.`,
    limitations: [],
    aggregation: measureAggregation(memberName),
  }
  if (memberName.endsWith("Rate")) annotation.format = "percent"
  if (memberName.includes("CostUsd") || memberName.endsWith("Usd"))
    annotation.currency = "USD"
  if (memberName.endsWith("Ms")) annotation.unit = "ms"
  if (memberName.endsWith("Count") || memberName === "traces.count")
    annotation.format = "integer"
  return annotation
}

function dimensionAnnotation(
  memberName: string,
  kind: "dimension" | "timeDimension"
): SemanticMemberAnnotation {
  return {
    name: member(memberName),
    kind,
    type: kind === "timeDimension" ? "date" : "string",
    title: titleFor(memberName),
    description: `Storybook fixture for ${titleFor(memberName)}.`,
    metricVersion,
    definition: `Deterministic ${titleFor(memberName)} fixture value.`,
    limitations: [],
  }
}

function dimensionValue(memberName: string, index: number) {
  const model = memberName.split(".")[0]
  const field = memberName.split(".").at(-1)
  if (model === "scoreValues") {
    if (field === "name") return "score"
    if (field === "definitionId")
      return index % 2 === 0
        ? "evaluator:brand-v3:score"
        : "evaluator:grounded-v2:score"
    if (field === "evaluatorName")
      return index % 2 === 0
        ? "Brand extraction: accuracy"
        : "Brand extraction: grounded brands"
    if (field === "evaluatorVersion") return index % 2 === 0 ? "3" : "2"
    if (field === "type") return "numeric"
    if (field === "scale") return "0–1"
    if (field === "origin") return "evaluator"
  }
  if (field === "operation")
    return index % 2 === 0 ? "chat.completion" : "tool.weather"
  if (field === "trace")
    return index % 2 === 0
      ? "Weather workflow · trace-weather-001"
      : "Assistant workflow · trace-assistant-002"
  if (field === "name") {
    if (model === "agents")
      return index % 2 === 0 ? "Weather agent" : "Support agent"
    if (model === "workflows")
      return index % 2 === 0 ? "Morning brief" : "Research workflow"
    return index % 2 === 0 ? "Weather workflow" : "Support workflow"
  }
  if (field === "version") return index % 2 === 0 ? "2026.09" : "2026.08"
  return index % 2 === 0 ? "Primary" : "Secondary"
}

function measureValue(memberName: string, index: number) {
  const field = memberName.split(".").at(-1)!
  const values: Record<string, number> = {
    count: 128 - index * 17,
    versionCount: 3 - (index % 2),
    spanCount: 612 - index * 42,
    llmCount: 318 - index * 24,
    otherCount: 192 - index * 14,
    toolCount: 102 - index * 7,
    errorRate: 0.024 + index * 0.008,
    completedCount: 108 - index * 12,
    erroredCount: 3 + index,
    runningCount: index,
    cancelledCount: 1,
    meanDurationMs: 347 + index * 31,
    p95DurationMs: 892 + index * 74,
    durationSampleCount: 111 - index * 13,
    reportedCostUsd: 2.3412 - index * 0.314,
    completeCostCount: 107 - index * 12,
    p95LatencyMs: 910 + index * 64,
    meanLatencyMs: 328 + index * 24,
    costUsd: 1.894 - index * 0.211,
    inputCostUsd: 0.924 - index * 0.103,
    outputCostUsd: 0.762 - index * 0.084,
    cacheCostUsd: 0.208 - index * 0.024,
    tokenCount: 28_420 - index * 2_100,
    inputTokens: 16_800 - index * 1_200,
    outputTokens: 9_320 - index * 800,
    cacheTokens: 2_300 - index * 100,
    p95TtftMs: 780 + index * 33,
    meanTtftMs: 415 + index * 22,
  }
  return values[field] ?? 10 + index
}

function timeValue(index: number) {
  return ["2026-09-08", "2026-09-09", "2026-09-10"][index % 3]!
}

function rowForQuery(
  query: NormalizedSemanticQuery,
  index: number,
  nullMeasures: boolean
): SemanticDataRow {
  const row: SemanticDataRow = {}
  const members = [
    ...query.dimensions,
    ...query.timeDimensions.map((time) => time.dimension),
    ...query.measures,
  ]
  for (const memberName of members) {
    if (query.measures.includes(memberName))
      row[memberName] = nullMeasures ? null : measureValue(memberName, index)
    else if (query.timeDimensions.some((time) => time.dimension === memberName))
      row[memberName] = timeValue(index)
    else row[memberName] = dimensionValue(memberName, index)
  }
  return row
}

export function semanticResultForQuery(
  input: unknown,
  options: { empty?: boolean; nullMeasures?: boolean; total?: number } = {}
): SemanticResult {
  const query = semanticQuerySchema.parse(input)
  const timeGrouping = query.timeDimensions.some((time) => time.granularity)
  const rowCount = options.empty
    ? 0
    : timeGrouping
      ? 3
      : query.dimensions.length
        ? 2
        : 1
  const requested = [
    ...query.measures,
    ...query.dimensions,
    ...query.timeDimensions.map((time) => time.dimension),
    ...query.segments,
  ]
  const annotation = {
    measures: Object.fromEntries(
      query.measures.map((memberName) => [
        memberName,
        measureAnnotation(memberName),
      ])
    ),
    dimensions: Object.fromEntries(
      query.dimensions.map((memberName) => [
        memberName,
        dimensionAnnotation(memberName, "dimension"),
      ])
    ),
    timeDimensions: Object.fromEntries(
      query.timeDimensions.map((time) => [
        time.dimension,
        dimensionAnnotation(time.dimension, "timeDimension"),
      ])
    ),
    segments: Object.fromEntries(
      query.segments.map((memberName) => [
        memberName,
        {
          ...dimensionAnnotation(memberName, "dimension"),
          kind: "segment" as const,
          type: "boolean" as const,
        },
      ])
    ),
  }
  return semanticResultSchema.parse({
    query,
    data: Array.from({ length: rowCount }, (_, index) =>
      rowForQuery(query, index, options.nullMeasures === true)
    ),
    annotation,
    meta: {
      contractVersion: "datool-semantic-v2",
      requestId: "storybook-dashboard-request",
      generatedAt: dashboardDates.asOf,
      asOf: dashboardDates.asOf,
      metricVersions: Object.fromEntries(
        requested.map((memberName) => [memberName, metricVersion])
      ),
      quality: { status: "complete", warnings: [], limitations: [] },
      page: {
        limit: query.limit,
        offset: query.offset,
        total:
          options.total ??
          (options.empty
            ? 0
            : timeGrouping ||
                !query.dimensions.length ||
                query.dimensions.includes("scoreValues.definitionId")
              ? rowCount
              : 4),
      },
    },
  })
}

function dashboardQuery(input: Record<string, unknown>) {
  return semanticQuerySchema.parse({
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: [dashboardDates.from, dashboardDates.to],
      },
    ],
    limit: 20,
    total: true,
    ...input,
  })
}

export const dashboardWidgets: DashboardWidget[] = [
  {
    id: "trace-count",
    title: "Trace volume",
    type: "metric",
    width: 1,
    query: dashboardQuery({ measures: ["traces.count"] }),
  },
  {
    id: "operations",
    title: "Operations",
    type: "bar",
    width: 1,
    query: dashboardQuery({
      measures: ["traces.count"],
      dimensions: ["traces.operation"],
      order: [["traces.count", "desc"]],
    }),
  },
  {
    id: "trace-table",
    title: "Trace operations",
    type: "table",
    width: 1,
    query: dashboardQuery({
      measures: ["traces.count"],
      dimensions: ["traces.operation"],
      order: [["traces.count", "desc"]],
      limit: 2,
    }),
  },
  {
    id: "spans",
    title: "Spans",
    type: "stacked",
    width: 2,
    query: semanticQuerySchema.parse({
      measures: ["logs.spanCount", "logs.llmCount", "logs.toolCount"],
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          dateRange: [dashboardDates.from, dashboardDates.to],
          granularity: "day",
        },
      ],
      limit: 20,
      total: true,
    }),
    series: ["logs.llmCount", "logs.toolCount"],
  },
  {
    id: "latency",
    title: "Latency",
    type: "line",
    width: 2,
    query: semanticQuerySchema.parse({
      measures: ["logs.p95LatencyMs", "logs.meanLatencyMs"],
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          dateRange: [dashboardDates.from, dashboardDates.to],
          granularity: "day",
        },
      ],
      limit: 20,
      total: true,
    }),
  },
  {
    id: "ttft",
    title: "Time to first token",
    type: "line",
    width: 1,
    query: semanticQuerySchema.parse({
      measures: ["logs.p95TtftMs", "logs.meanTtftMs"],
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          dateRange: [dashboardDates.from, dashboardDates.to],
          granularity: "day",
        },
      ],
      limit: 20,
      total: true,
    }),
  },
]

export const metricWidget = dashboardWidgets[0]!
export const barWidget = dashboardWidgets[1]!
export const tableWidget = dashboardWidgets[2]!
export const metricResult = semanticResultForQuery(metricWidget.query)
export const emptyMetricResult = semanticResultForQuery(metricWidget.query, {
  empty: true,
})
export const barResult = semanticResultForQuery(barWidget.query)
export const tableResult = semanticResultForQuery(tableWidget.query)

export const storybookDashboard: Dashboard = {
  id: "dashboard-observability",
  revision: 3,
  schemaVersion: 1,
  name: "Observability overview",
  description:
    "Trace volume, operations, and latency in a fixed Storybook window.",
  widgets: dashboardWidgets,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: dashboardDates.asOf,
}

export const savedDashboard: Dashboard = {
  ...storybookDashboard,
  revision: 4,
  name: "Observability overview saved",
  updatedAt: "2026-09-11T12:05:00.000Z",
}

export const createdDashboard: Dashboard = {
  ...storybookDashboard,
  id: "dashboard-created",
  revision: 1,
  name: "New observability dashboard",
  createdAt: "2026-09-11T12:01:00.000Z",
  updatedAt: "2026-09-11T12:01:00.000Z",
}

export const dashboardList: Dashboard[] = [
  storybookDashboard,
  {
    ...storybookDashboard,
    id: "dashboard-quality",
    name: "Quality overview",
    description: "A compact view of evaluation quality.",
    widgets: [dashboardWidgets[0]!],
    updatedAt: "2026-09-10T09:00:00.000Z",
  },
]

export const barRows: SemanticDataRow[] = [
  { "traces.operation": "chat.completion", "traces.count": 128 },
  { "traces.operation": "tool.weather", "traces.count": 84 },
  { "traces.operation": "eval.grade", "traces.count": -12 },
]

export const barMeasureAnnotation = measureAnnotation("traces.count")
export const lineWidget = dashboardWidgets.find(
  (widget) => widget.id === "latency"
)!
export const stackedWidget = dashboardWidgets.find(
  (widget) => widget.id === "spans"
)!
export const ttftWidget = dashboardWidgets.find(
  (widget) => widget.id === "ttft"
)!
export const lineResult = semanticResultForQuery(lineWidget.query)
export const lineSummary = semanticResultForQuery({
  ...lineWidget.query,
  timeDimensions: lineWidget.query.timeDimensions.map((time) => ({
    dimension: time.dimension,
    dateRange: time.dateRange,
  })),
})
export const stackedResult = semanticResultForQuery(stackedWidget.query)
export const stackedSummary = semanticResultForQuery({
  ...stackedWidget.query,
  timeDimensions: stackedWidget.query.timeDimensions.map((time) => ({
    dimension: time.dimension,
    dateRange: time.dateRange,
  })),
})
export const emptyTtftResult = semanticResultForQuery(ttftWidget.query, {
  nullMeasures: true,
})
export const emptyTtftSummary = semanticResultForQuery(
  {
    ...ttftWidget.query,
    timeDimensions: ttftWidget.query.timeDimensions.map((time) => ({
      dimension: time.dimension,
      dateRange: time.dateRange,
    })),
  },
  { nullMeasures: true }
)

function metricDefinition(
  name: string,
  title: string
): SemanticMemberDefinition {
  return {
    name: member(name),
    title,
    description: `Storybook fixture for ${title}.`,
    metricVersion,
    definition: `Deterministic ${title} fixture.`,
    kind: "measure",
    type: "number",
    aggregation: measureAggregation(name),
  }
}

function dimensionDefinition(
  name: string,
  title: string
): SemanticMemberDefinition {
  return {
    name: member(name),
    title,
    description: `Storybook fixture for ${title}.`,
    metricVersion,
    definition: `Deterministic ${title} fixture.`,
    kind: "dimension",
    type: "string",
    filterOperators: ["equals", "notEquals", "contains"],
  }
}

function timeDimensionDefinition(
  name: string,
  title: string
): SemanticMemberDefinition {
  return {
    name: member(name),
    title,
    description: `Storybook fixture for ${title}.`,
    metricVersion,
    definition: `Deterministic ${title} fixture.`,
    kind: "timeDimension",
    type: "date",
    granularities: ["day", "week", "month"],
  }
}

export const dashboardCatalog: SemanticCatalogMetadata = {
  models: [
    {
      name: "traces",
      version: metricVersion,
      defaultMeasures: [member("traces.count")],
      maxLimit: 100,
      members: [
        ...traceRelationshipMembers("traces", metricVersion),
        metricDefinition("traces.count", "Traces"),
        metricDefinition("traces.errorRate", "Error rate"),
        metricDefinition("traces.erroredCount", "Errored traces"),
        dimensionDefinition("traces.operation", "Operation"),
        dimensionDefinition("traces.trace", "Trace"),
        timeDimensionDefinition("traces.startedAt", "Started at"),
      ],
    },
    {
      name: "logs",
      version: metricVersion,
      defaultMeasures: [member("logs.spanCount")],
      maxLimit: 100,
      members: [
        ...[
          "spanCount",
          "erroredCount",
          "errorRate",
          "llmCount",
          "otherCount",
          "toolCount",
          "p95LatencyMs",
          "meanLatencyMs",
          "costUsd",
          "inputCostUsd",
          "outputCostUsd",
          "cacheCostUsd",
          "tokenCount",
          "inputTokens",
          "outputTokens",
          "cacheTokens",
          "p95TtftMs",
          "meanTtftMs",
        ].map((name) =>
          metricDefinition(`logs.${name}`, titleFor(`logs.${name}`))
        ),
        ...traceRelationshipMembers("logs", metricVersion),
        dimensionDefinition("logs.functionName", "LLM call name"),
        dimensionDefinition("logs.model", "LLM model"),
        dimensionDefinition("logs.agentName", "Agent"),
        dimensionDefinition("logs.workflowName", "Workflow"),
        dimensionDefinition("logs.stepName", "Step"),
        timeDimensionDefinition("logs.startedAt", "Started at"),
      ],
    },
  ],
}

// Include new sources while retaining legacy widgets as compatibility fixtures.
const legacyLogs = dashboardCatalog.models.find(
  (model) => model.name === "logs"
)!
const primarySources = [
  [
    "traces",
    "Traces",
    "Whole requests: failures, duration and total child LLM usage.",
  ],
  [
    "spans",
    "Spans",
    "Individual steps: LLM calls, tool calls, duration, tokens and cost.",
  ],
  [
    "evalRuns",
    "Evaluation Runs",
    "Evaluation batches: lifecycle, selected cases and execution coverage.",
  ],
  [
    "evalResults",
    "Evaluation Results",
    "Scorer executions: quality outcomes, errors and saved case context.",
  ],
  [
    "scoreValues",
    "Scores",
    "Saved ratings from scorers, imports and reviews, with explicit types and scales.",
  ],
]
const newModels: SemanticCatalogMetadata["models"][number][] = [
  {
    ...legacyLogs,
    name: "spans",
    defaultMeasures: ["spans.spanCount"],
    members: legacyLogs.members
      .filter((m) => !m.name.includes("LatencyMs"))
      .map((m) => ({ ...m, name: m.name.replace(/^logs[.]/, "spans.") })),
  },
  ...["evalRuns", "evalResults", "scoreValues"].map((name) => ({
    name,
    version: metricVersion,
    defaultMeasures: [
      `${name}.${name === "evalResults" ? "executionCount" : "count"}`,
    ],
    maxLimit: 5000,
    members: [
      metricDefinition(
        `${name}.${name === "evalResults" ? "executionCount" : "count"}`,
        name === "scoreValues" ? "Saved ratings" : "Count"
      ),
      timeDimensionDefinition(
        `${name}.${name === "evalRuns" ? "createdAt" : name === "evalResults" ? "completedAt" : "recordedAt"}`,
        "Recorded at"
      ),
      ...(name === "scoreValues"
        ? [
            {
              ...metricDefinition(
                "scoreValues.meanValue",
                "Average numeric value"
              ),
              requiresDefinition: true,
            },
            ...[
              "definitionId",
              "name",
              "origin",
              "type",
              "scale",
              "evaluatorName",
              "evaluatorVersion",
            ].map((key) =>
              dimensionDefinition(
                `scoreValues.${key}`,
                key === "definitionId" ? "Score definition" : key
              )
            ),
          ]
        : name === "evalResults"
          ? [
              metricDefinition("evalResults.meanScore", "Average score"),
              metricDefinition("evalResults.p50Score", "P50 score"),
              metricDefinition("evalResults.p95Score", "P95 score"),
              ...[
                ["groupName", "Operation"],
                ["promptId", "Prompt ID"],
                ["promptVersion", "Prompt version"],
                ["evaluatorVersion", "Scorer version"],
                ["datasetId", "Dataset ID"],
              ].map(([key, title]) =>
                dimensionDefinition(`evalResults.${key}`, title)
              ),
              dimensionDefinition(
                "evalResults.evaluatorVersionId",
                "Scorer version ID"
              ),
              dimensionDefinition("evalResults.evaluatorName", "Scorer"),
            ]
          : []),
    ],
  })),
]
;(dashboardCatalog as { models: typeof newModels }).models = [
  ...dashboardCatalog.models,
  ...newModels,
].map((model) => {
  const order = primarySources.findIndex(([name]) => model.name === name)
  return {
    ...model,
    source:
      order < 0
        ? {
            title: "Spans & LLM usage (legacy)",
            description:
              "Original mixed span usage and request latency definitions.",
            grain: "Legacy",
            visibility: "legacy",
            replacement: "spans",
          }
        : {
            title: primarySources[order][1],
            description: primarySources[order][2],
            grain: "One recorded fact",
            visibility: "primary",
            order,
          },
  }
})

export function performanceQuery(model: PerformanceModel) {
  return semanticQuerySchema.parse({
    measures: performanceMeasures.map((name) => `${model}.${name}`),
    dimensions: [`${model}.name`],
    timeDimensions: [
      {
        dimension: `${model}.startedAt`,
        dateRange: [dashboardDates.from, dashboardDates.to],
      },
    ],
    order: [[`${model}.count`, "desc"]],
    limit: 50,
    total: true,
  })
}

export function performanceResult(
  model: PerformanceModel,
  options: { empty?: boolean } = {}
) {
  return semanticResultForQuery(performanceQuery(model), options)
}

export function isNoMatchQuery(input: unknown) {
  if (!input || typeof input !== "object") return false
  const filters = (input as { filters?: unknown }).filters
  return JSON.stringify(filters).includes("No match")
}
