import {
  semanticQuerySchema,
  type NormalizedSemanticQuery,
} from "@/src/lib/semantic/query"
import { healthDashboard, logsDashboardWidgets } from "./dashboard-presets"
import type { DashboardDataInput, DashboardWidget } from "./dashboards"

type DashboardTemplate = {
  id: string
  name: string
  description: string
  create: (now?: Date) => DashboardDataInput
}

type QueryOptions = Pick<
  Partial<NormalizedSemanticQuery>,
  "filters" | "having" | "order"
>

function widgetBuilder(now: Date) {
  function chart(
    id: string,
    title: string,
    type: DashboardWidget["type"],
    measures: string[],
    dimensions: string[] = [],
    options: QueryOptions = {}
  ): DashboardWidget {
    const model = measures[0].split(".")[0]
    const time =
      model === "scores" || model === "evalQuality" || model === "evalResults"
        ? "completedAt"
        : model === "evalRuns"
          ? "createdAt"
          : "startedAt"
    return {
      id,
      title,
      type,
      width: 2,
      query: semanticQuerySchema.parse({
        measures,
        dimensions,
        timeDimensions: [
          {
            dimension: `${model}.${time}`,
            dateRange: [
              new Date(now.getTime() - 7 * 86400000).toISOString(),
              now.toISOString(),
            ],
            ...(["line", "stacked"].includes(type)
              ? { granularity: "day" }
              : {}),
          },
        ],
        order:
          dimensions.length && !["line", "stacked"].includes(type)
            ? [
                [measures[0], "desc"],
                ...dimensions.map((dimension) => [dimension, "asc"]),
              ]
            : [],
        limit:
          ["line", "stacked"].includes(type) && dimensions.length
            ? 5000
            : dimensions.length
              ? 10
              : 100,
        total: true,
        ...options,
      }),
    }
  }
  return {
    chart,
    metric: (id: string, title: string, measure: string) =>
      chart(id, title, "metric", [measure]),
    logs: (...ids: string[]) =>
      logsDashboardWidgets(now).filter((widget) => ids.includes(widget.id)),
  }
}

/** Four compact summary tiles per row, followed by pairs of charts and tables. */
function arrangeWidgets(
  widgets: DashboardWidget[],
  now: Date
): DashboardWidget[] {
  const tiles = widgets.filter((widget) => widget.type === "metric")
  const charts = widgets.filter((widget) => widget.type !== "metric")
  return [...tiles, ...charts].map((widget, index) => {
    const tile = index < tiles.length
    const chartIndex = index - tiles.length
    return {
      ...widget,
      width: tile ? 1 : 2,
      layout: {
        x: tile ? (index % 4) * 3 : (chartIndex % 2) * 6,
        y: tile
          ? Math.floor(index / 4) * 3
          : Math.ceil(tiles.length / 4) * 3 + Math.floor(chartIndex / 2) * 6,
        w: tile ? 3 : 6,
        h: tile ? 3 : 6,
      },
      query: {
        ...widget.query,
        timeDimensions: widget.query.timeDimensions.map((time) => ({
          ...time,
          dateRange: [
            new Date(now.getTime() - 7 * 86400000).toISOString(),
            now.toISOString(),
          ],
        })),
      },
    }
  })
}

function template(
  id: string,
  name: string,
  description: string,
  build: (
    widgets: ReturnType<typeof widgetBuilder>,
    now: Date
  ) => DashboardWidget[]
): DashboardTemplate {
  return {
    id,
    name,
    description,
    create: (now = new Date()) => ({
      schemaVersion: 1,
      name,
      description,
      defaultWindowDays: 7,
      widgets: arrangeWidgets(build(widgetBuilder(now), now), now),
    }),
  }
}

const positiveCost: QueryOptions = {
  filters: [{ member: "spans.spanCostUsd", operator: "gt", values: [0] }],
}

/** Independent, editable queries against the project's registered semantic models. */
export const dashboardTemplates: readonly DashboardTemplate[] = [
  template(
    "weekly-health",
    "Weekly health",
    "Track failures, recurring errors, affected users, and request health.",
    ({ chart }, now) => [
      ...healthDashboard(now).widgets,
      chart(
        "trace-status",
        "Trace status breakdown",
        "donut",
        ["traces.count"],
        ["traces.status"]
      ),
      chart("failure-rate-trend", "Trace failure rate by day", "line", [
        "traces.errorRate",
      ]),
      chart("request-volume", "Request volume by day", "line", [
        "traces.count",
      ]),
      chart("request-latency", "Request latency by day", "line", [
        "traces.meanDurationMs",
        "traces.p95DurationMs",
      ]),
    ]
  ),
  template(
    "llm-overview",
    "LLM overview",
    "Monitor traffic, failures, latency, and LLM usage with request and span breakdowns.",
    ({ metric, chart, logs }) => [
      metric("total-traces", "Total traces", "traces.count"),
      metric("llm-calls", "LLM calls", "spans.llmCount"),
      metric("total-cost", "Total LLM cost", "spans.costUsd"),
      metric("trace-failure-rate", "Trace failure rate", "traces.errorRate"),
      ...logs("spans", "latency", "llm-cost", "tokens", "ttft"),
      chart("failure-trend", "Trace failures by day", "line", [
        "traces.erroredCount",
      ]),
      chart(
        "calls-by-span",
        "LLM calls by span",
        "bar",
        ["spans.llmCount"],
        ["spans.spanName"],
        {
          having: [{ member: "spans.llmCount", operator: "gt", values: [0] }],
        }
      ),
      chart(
        "request-performance",
        "Request performance",
        "table",
        ["traces.count", "traces.errorRate", "traces.p95DurationMs"],
        ["traces.traceName"]
      ),
    ]
  ),
  template(
    "cost-and-usage",
    "Cost and usage",
    "Understand LLM spend, cache usage, and the requests and spans driving consumption.",
    ({ metric, chart, logs }) => [
      metric("llm-cost-total", "Total LLM cost", "spans.costUsd"),
      metric("tokens-total", "Total tokens", "spans.tokenCount"),
      metric("llm-calls", "LLM calls", "spans.llmCount"),
      metric("cached-tokens", "Cached input tokens", "spans.cacheTokens"),
      ...logs("llm-cost", "tokens"),
      chart(
        "cost-by-model",
        "Cost by model over time",
        "line",
        ["spans.costUsd"],
        ["spans.model"],
        {
          filters: [
            { member: "spans.hasCost", operator: "equals", values: ["yes"] },
          ],
        }
      ),
      chart(
        "cost-by-span",
        "Cost by LLM call",
        "bar",
        ["spans.costUsd"],
        ["spans.functionName"],
        positiveCost
      ),
      chart(
        "cost-by-request",
        "Cost by request name",
        "bar",
        ["spans.costUsd"],
        ["spans.traceName"],
        positiveCost
      ),
      chart(
        "tokens-by-span",
        "Tokens by LLM call",
        "bar",
        ["spans.tokenCount"],
        ["spans.functionName"],
        {
          having: [{ member: "spans.tokenCount", operator: "gt", values: [0] }],
        }
      ),
      chart(
        "usage-by-span",
        "Usage by LLM call",
        "table",
        [
          "spans.costUsd",
          "spans.llmCount",
          "spans.inputTokens",
          "spans.outputTokens",
          "spans.cacheTokens",
        ],
        ["spans.functionName"],
        {
          having: [{ member: "spans.llmCount", operator: "gt", values: [0] }],
        }
      ),
    ]
  ),
  template(
    "latency",
    "Latency and responsiveness",
    "Track average and P95 timings and identify slow requests, operations, and LLM calls.",
    ({ metric, chart, logs }) => [
      metric("latency-total", "P95 latency", "traces.p95DurationMs"),
      metric("ttft-total", "P95 time to first token", "spans.p95TtftMs"),
      metric("mean-latency", "Average latency", "traces.meanDurationMs"),
      metric("mean-ttft", "Average time to first token", "spans.meanTtftMs"),
      ...logs("latency", "ttft"),
      chart(
        "slow-requests",
        "Slowest request names",
        "table",
        ["traces.p95DurationMs", "traces.meanDurationMs", "traces.count"],
        ["traces.traceName"],
        {
          having: [
            { member: "traces.p95DurationMs", operator: "gt", values: [0] },
          ],
        }
      ),
      chart(
        "first-token-by-span",
        "First-token timing by span",
        "table",
        ["spans.p95TtftMs", "spans.meanTtftMs", "spans.llmCount"],
        ["spans.spanName"],
        {
          having: [{ member: "spans.p95TtftMs", operator: "set" }],
        }
      ),
      chart(
        "latency-by-operation",
        "Latency by operation",
        "bar",
        ["traces.meanDurationMs"],
        ["traces.operation"],
        {
          having: [{ member: "traces.meanDurationMs", operator: "set" }],
        }
      ),
      chart("request-volume", "Request volume by day", "line", [
        "traces.count",
      ]),
    ]
  ),
  template(
    "evals",
    "Evaluations",
    "Monitor eval runs, pass rates, and errors by evaluator, agent, workflow, and run.",
    ({ metric, chart }) => [
      metric("eval-runs", "Evaluation runs", "evalRuns.count"),
      metric(
        "eval-executions",
        "Evaluator executions",
        "evalResults.executionCount"
      ),
      metric(
        "eval-pass-rate",
        "Explicit pass rate",
        "evalResults.explicitPassRate"
      ),
      metric("eval-errors", "Evaluator errors", "evalResults.errorCount"),
      chart("eval-run-volume", "Evaluation runs by day", "line", [
        "evalRuns.count",
        "evalRuns.completedCount",
        "evalRuns.failedCount",
        "evalRuns.partialCount",
      ]),
      chart(
        "eval-run-status",
        "Run status breakdown",
        "donut",
        ["evalRuns.count"],
        ["evalRuns.status"]
      ),
      chart("eval-pass-trend", "Explicit pass rate by day", "line", [
        "evalResults.explicitPassRate",
      ]),
      chart(
        "eval-result-status",
        "Result status breakdown",
        "donut",
        ["evalResults.executionCount"],
        ["evalResults.status"]
      ),
      chart("eval-error-trend", "Evaluator errors by day", "line", [
        "evalResults.errorCount",
      ]),
      chart(
        "eval-fails-by-evaluator",
        "Failed checks by evaluator",
        "bar",
        ["evalResults.explicitFailCount"],
        ["evalResults.evaluatorName"],
        {
          having: [
            {
              member: "evalResults.explicitFailCount",
              operator: "gt",
              values: [0],
            },
          ],
        }
      ),
      chart(
        "eval-evaluator-results",
        "Results by evaluator and version",
        "table",
        [
          "evalResults.executionCount",
          "evalResults.meanScore",
          "evalResults.explicitPassRate",
          "evalResults.errorCount",
        ],
        ["evalResults.evaluatorName", "evalResults.evaluatorVersion"]
      ),
      chart(
        "eval-run-results",
        "Results by evaluation run",
        "table",
        [
          "evalResults.executionCount",
          "evalResults.explicitPassRate",
          "evalResults.errorCount",
        ],
        ["evalResults.evalRunName", "evalResults.runId"]
      ),
      ...(["agent", "workflow"] as const).flatMap((type) => {
        const filters: QueryOptions = {
          filters: [
            {
              member: "evalResults.groupType",
              operator: "equals",
              values: [type],
            },
          ],
        }
        return [
          chart(
            `eval-pass-by-${type}`,
            `Pass rate by ${type}`,
            "bar",
            ["evalResults.explicitPassRate"],
            ["evalResults.groupName"],
            filters
          ),
          chart(
            `eval-results-by-${type}`,
            `Results by ${type} and evaluator`,
            "table",
            [
              "evalResults.executionCount",
              "evalResults.explicitPassRate",
              "evalResults.meanScore",
              "evalResults.errorCount",
            ],
            [
              "evalResults.groupName",
              "evalResults.groupVersion",
              "evalResults.evaluatorName",
              "evalResults.evaluatorVersion",
            ],
            filters
          ),
        ]
      }),
    ]
  ),
  template(
    "eval-quality-by-model",
    "Evaluation quality by model",
    "Compare case scores by workflow, agent, and observed workload model. Filter to comparable scorers and cases.",
    ({ chart, metric }) => [
      metric("quality-average", "Average score", "evalResults.meanScore"),
      metric("quality-samples", "Scored results", "evalResults.scoredCount"),
      metric(
        "quality-executions",
        "Scorer executions",
        "evalResults.executionCount"
      ),
      metric("quality-errors", "Scorer errors", "evalResults.errorCount"),
      ...(["workflow", "agent"] as const).flatMap((type) => {
        const filters = [
          {
            member: "evalResults.groupType",
            operator: "equals" as const,
            values: [type],
          },
        ]
        return [
          chart(
            `quality-${type}-model`,
            `Average score by ${type} and model`,
            "bar",
            ["evalResults.meanScore"],
            ["evalResults.groupName", "evalResults.model"],
            { filters }
          ),
          chart(
            `quality-${type}-samples`,
            `${type === "agent" ? "Agent" : "Workflow"} scores and sample sizes`,
            "table",
            [
              "evalResults.meanScore",
              "evalResults.scoredCount",
              "evalResults.errorCount",
            ],
            [
              "evalResults.groupName",
              "evalResults.model",
              "evalResults.evaluatorName",
              "evalResults.evaluatorVersion",
            ],
            { filters }
          ),
        ]
      }),
    ]
  ),
]

export function blankDashboard(): DashboardDataInput {
  return {
    schemaVersion: 1,
    name: "Untitled dashboard",
    description: "",
    widgets: [],
  }
}
