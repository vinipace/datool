"use client"

import { DashboardTimeChart } from "@/components/tracer/dashboard-time-chart"
import { cn } from "@/lib/utils"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type {
  SemanticMemberAnnotation,
  SemanticResult,
} from "@/src/lib/semantic/result"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"

const passRate: SemanticMemberAnnotation = {
  name: "scores.explicitPassRate",
  kind: "measure",
  type: "number",
  title: "Helpful answers",
  description: "Share of answers scored helpful in this illustrative sample.",
  format: "percent",
  metricVersion: "example-v1",
  definition: "Illustrative weekly share of agent answers scored helpful.",
  limitations: ["Sample data, not a live application run."],
}
const agents = [
  {
    name: "Stride Sales",
    values: [0.71, 0.74, 0.73, 0.79, 0.8, 0.84, 0.83, 0.88, 0.9, 0.92],
  },
  {
    name: "Stride Support",
    values: [0.62, 0.66, 0.65, 0.7, 0.74, 0.73, 0.79, 0.82, 0.85, 0.87],
  },
]
const weeks = agents[0].values.map((_, index) =>
  new Date(Date.UTC(2026, 7, 3 + index * 7)).toISOString().slice(0, 10)
)

const widget: DashboardWidget = {
  id: "example-helpful-answers",
  title: "Helpful answers",
  type: "line",
  width: 2,
  query: semanticQuerySchema.parse({
    measures: [passRate.name],
    dimensions: ["scores.agentName"],
    timeDimensions: [
      {
        dimension: "scores.startedAt",
        dateRange: ["2026-08-03T00:00:00Z", "2026-10-12T00:00:00Z"],
        granularity: "week",
      },
    ],
    timezone: "UTC",
    total: true,
    limit: 20,
  }),
}
const result: SemanticResult = {
  query: widget.query,
  data: agents.flatMap((agent) =>
    agent.values.map((value, index) => ({
      "scores.startedAt": weeks[index],
      "scores.agentName": agent.name,
      [passRate.name]: value,
    }))
  ),
  annotation: {
    measures: { [passRate.name]: passRate },
    dimensions: {
      "scores.agentName": {
        name: "scores.agentName",
        kind: "dimension",
        type: "string",
        title: "Agent",
        description: "The agent that answered.",
        definition: "Recorded agent name.",
        metricVersion: "example-v1",
        limitations: [],
      },
    },
    segments: {},
    timeDimensions: {
      "scores.startedAt": {
        name: "scores.startedAt",
        kind: "timeDimension",
        type: "date",
        title: "Started at",
        description: "Week of the sampled conversations.",
        definition: "UTC calendar week.",
        metricVersion: "example-v1",
        limitations: [],
      },
    },
  },
  meta: {
    contractVersion: "datool-semantic-v2",
    requestId: "marketing-helpful-answers",
    generatedAt: "2026-10-12T00:00:00Z",
    asOf: "2026-10-12T00:00:00Z",
    metricVersions: {
      [passRate.name]: passRate.metricVersion,
      "scores.startedAt": "example-v1",
      "scores.agentName": "example-v1",
    },
    quality: {
      status: "complete",
      warnings: [],
      limitations: ["Illustrative sample data."],
    },
    page: { limit: 20, offset: 0, total: 20 },
  },
}

/** The production dashboard line chart with clearly labeled sample scores. */
export function HomeQualityChart({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-48 min-w-0", className)}
      aria-label="Example helpful answers chart"
    >
      <DashboardTimeChart widget={widget} result={result} summary={null} />
    </div>
  )
}
