import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type { DashboardInput, DashboardWidget } from "./dashboards"

/** The reference logs layout, with Topics omitted. */
export function logsDashboardWidgets(now = new Date()): DashboardWidget[] {
  const timeDimensions = [
    {
      dimension: "spans.startedAt",
      dateRange: [
        new Date(now.getTime() - 3 * 86400000).toISOString(),
        now.toISOString(),
      ],
      granularity: "day",
    },
  ]
  const make = (
    id: string,
    title: string,
    type: "stacked" | "line",
    measures: string[],
    series = measures
  ): DashboardWidget => {
    const requestLatency = measures.some((m) => m.endsWith("LatencyMs"))
    const model = requestLatency ? "traces" : "spans"
    const member = (m: string) =>
      `${model}.${m.replace("LatencyMs", "DurationMs")}`
    return {
      id,
      title,
      type,
      width: 1,
      query: semanticQuerySchema.parse({
        measures: measures.map(member),
        timeDimensions: timeDimensions.map((time) => ({
          ...time,
          dimension: `${model}.startedAt`,
        })),
        limit: 100,
        total: true,
      }),
      series: series.map(member),
    }
  }
  return [
    make(
      "spans",
      "Spans",
      "stacked",
      ["spanCount", "llmCount", "otherCount", "toolCount"],
      ["llmCount", "otherCount", "toolCount"]
    ),
    make("latency", "Latency", "line", ["p95LatencyMs", "meanLatencyMs"]),
    make(
      "llm-cost",
      "Total LLM cost",
      "stacked",
      ["costUsd", "inputCostUsd", "outputCostUsd", "cacheCostUsd"],
      ["inputCostUsd", "outputCostUsd", "cacheCostUsd"]
    ),
    make(
      "tokens",
      "Token count",
      "stacked",
      ["tokenCount", "inputTokens", "outputTokens", "cacheTokens"],
      ["inputTokens", "outputTokens", "cacheTokens"]
    ),
    make("ttft", "Time to first token", "line", ["p95TtftMs", "meanTtftMs"]),
  ]
}

/** Uses the same editable catalog queries as manually created widgets. */
export function healthDashboard(now = new Date()): DashboardInput {
  const dateRange = [
    new Date(now.getTime() - 7 * 86400000).toISOString(),
    now.toISOString(),
  ]
  function widget(
    id: string,
    title: string,
    type: DashboardWidget["type"],
    measures: string[],
    dimensions: string[],
    layout: NonNullable<DashboardWidget["layout"]>,
    failuresOnly = false
  ): DashboardWidget {
    const model = measures[0].split(".")[0]
    return {
      id,
      title,
      type,
      width: Math.min(3, Math.ceil(layout.w / 4)) as 1 | 2 | 3,
      layout,
      query: semanticQuerySchema.parse({
        measures,
        dimensions,
        timeDimensions: [
          {
            dimension: `${model}.startedAt`,
            dateRange,
            ...(type === "line" ? { granularity: "day" } : {}),
          },
        ],
        ...(failuresOnly
          ? {
              having: [
                {
                  member: `${model}.erroredCount`,
                  operator: "gt",
                  values: [0],
                },
              ],
            }
          : {}),
        // Filter spans before grouping error messages; trace rankings retain the rate denominator.
        ...(failuresOnly && model === "spans"
          ? {
              filters: [
                {
                  member: "spans.spanStatus",
                  operator: "equals",
                  values: ["errored"],
                },
              ],
            }
          : {}),
        order: dimensions.length
          ? [
              [`${model}.erroredCount`, "desc"],
              ...dimensions.map((d) => [d, "asc"]),
            ]
          : [],
        limit: type === "table" || type === "bar" ? 10 : 100,
        total: true,
      }),
    }
  }
  return {
    schemaVersion: 1,
    name: "Weekly health",
    description: "",
    defaultWindowDays: 7,
    widgets: [
      widget("requests", "Total traces", "metric", ["traces.count"], [], {
        x: 0,
        y: 0,
        w: 3,
        h: 3,
      }),
      widget(
        "failures",
        "Failed traces",
        "metric",
        ["traces.erroredCount"],
        [],
        { x: 3, y: 0, w: 3, h: 3 }
      ),
      widget(
        "failure-rate",
        "Trace failure rate",
        "metric",
        ["traces.errorRate"],
        [],
        { x: 6, y: 0, w: 3, h: 3 }
      ),
      widget(
        "span-errors",
        "Failed spans",
        "metric",
        ["spans.erroredCount"],
        [],
        { x: 9, y: 0, w: 3, h: 3 }
      ),
      widget(
        "failure-trend",
        "Failed traces by day",
        "line",
        ["traces.erroredCount"],
        [],
        { x: 0, y: 3, w: 6, h: 5 }
      ),
      widget(
        "failing-traces",
        "Which requests are failing?",
        "table",
        ["traces.erroredCount", "traces.count", "traces.errorRate"],
        ["traces.traceName"],
        { x: 6, y: 3, w: 6, h: 5 },
        true
      ),
      widget(
        "biggest-errors",
        "Most frequent errors",
        "table",
        ["spans.erroredCount"],
        ["spans.errorMessage"],
        { x: 0, y: 8, w: 8, h: 6 },
        true
      ),
      widget(
        "error-types",
        "Error types",
        "donut",
        ["spans.erroredCount"],
        ["spans.errorType"],
        { x: 8, y: 8, w: 4, h: 6 },
        true
      ),
      widget(
        "affected-users",
        "Which users are affected?",
        "table",
        ["traces.erroredCount", "traces.count", "traces.errorRate"],
        ["traces.userId"],
        { x: 0, y: 14, w: 6, h: 5 },
        true
      ),
      widget(
        "failing-calls",
        "Where are span errors happening?",
        "table",
        ["spans.erroredCount"],
        ["spans.spanName", "spans.traceName"],
        { x: 6, y: 14, w: 6, h: 5 },
        true
      ),
    ],
  }
}
