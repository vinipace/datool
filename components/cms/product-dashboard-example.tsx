"use client"

import { DashboardTimeChart } from "@/components/tracer/dashboard-time-chart"
import { Card, CardHeader, CardDescription } from "@/components/ui/card"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type {
  SemanticMemberAnnotation,
  SemanticResult,
} from "@/src/lib/semantic/result"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"

const latency: SemanticMemberAnnotation = {
  name: "logs.p95LatencyMs",
  kind: "measure",
  type: "number",
  title: "P95 latency",
  description: "95th percentile of span latency in this illustrative sample.",
  unit: "ms",
  metricVersion: "example-v1",
  definition: "Illustrative daily P95 span latency.",
  limitations: ["Sample data, not a live application run."],
}
const spanCount: SemanticMemberAnnotation = {
  ...latency,
  name: "logs.spanCount",
  title: "Spans",
  description: "Recorded spans in this illustrative sample.",
  definition: "Illustrative span count grouped by operation.",
  unit: undefined,
  format: "integer",
  aggregation: "count",
}
const operations = [
  {
    name: "search.documents",
    latency: [1240, 1380, 1190, 1720, 2350, 1910, 1420],
    count: [142, 161, 174, 207, 236, 195, 169],
  },
  {
    name: "generate.answer",
    latency: [820, 960, 870, 1150, 1360, 1080, 940],
    count: [131, 148, 165, 192, 221, 181, 158],
  },
  {
    name: "verify.sources",
    latency: [260, 310, 280, 390, 510, 420, 330],
    count: [122, 138, 151, 177, 202, 169, 149],
  },
]

function exampleChart(
  title: string,
  type: "line" | "stacked",
  measure: SemanticMemberAnnotation,
  values: "latency" | "count"
): { widget: DashboardWidget; result: SemanticResult } {
  const widget: DashboardWidget = {
    id: `example-${values}`,
    title,
    type,
    width: 2,
    query: semanticQuerySchema.parse({
      measures: [measure.name],
      dimensions: ["logs.spanName"],
      timeDimensions: [
        {
          dimension: "logs.startedAt",
          dateRange: ["2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"],
          granularity: "day",
        },
      ],
      timezone: "UTC",
      total: true,
      limit: 21,
    }),
  }
  const result: SemanticResult = {
    query: widget.query,
    data: operations.flatMap((operation) =>
      operation[values].map((value, index) => ({
        "logs.startedAt": `2026-09-0${index + 1}`,
        "logs.spanName": operation.name,
        [measure.name]: value,
      }))
    ),
    annotation: {
      measures: { [measure.name]: measure },
      dimensions: {
        "logs.spanName": {
          name: "logs.spanName",
          kind: "dimension",
          type: "string",
          title: "Operation",
          description: "The operation performed by a span.",
          definition: "Recorded span name.",
          metricVersion: "example-v1",
          limitations: [],
        },
      },
      segments: {},
      timeDimensions: {
        "logs.startedAt": {
          name: "logs.startedAt",
          kind: "timeDimension",
          type: "date",
          title: "Started at",
          description: "Day of the sampled spans.",
          definition: "UTC calendar day.",
          metricVersion: "example-v1",
          limitations: [],
        },
      },
    },
    meta: {
      contractVersion: "datool-semantic-v2",
      requestId: "marketing-dashboard-example",
      generatedAt: "2026-09-08T00:00:00Z",
      asOf: "2026-09-08T00:00:00Z",
      metricVersions: {
        [measure.name]: measure.metricVersion,
        "logs.startedAt": "example-v1",
        "logs.spanName": "example-v1",
      },
      quality: {
        status: "complete",
        warnings: [],
        limitations: ["Illustrative sample data."],
      },
      page: { limit: 21, offset: 0, total: 21 },
    },
  }
  return { widget, result }
}
const latencyChart = exampleChart("Span latency", "line", latency, "latency")
const volumeChart = exampleChart(
  "Spans by operation",
  "stacked",
  spanCount,
  "count"
)

/** Production dashboard widgets with deterministic, clearly labeled sample data. */
export function ProductDashboardExample() {
  return (
    <div
      className="min-w-0 space-y-3"
      aria-label="Example observability dashboard"
    >
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>
            P95 latency for each step of your application.
          </CardDescription>
        </CardHeader>
        <div className="h-80 min-w-0">
          <DashboardTimeChart {...latencyChart} summary={null} />
        </div>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Daily span volume by operation.</CardDescription>
        </CardHeader>
        <div className="h-80 min-w-0">
          <DashboardTimeChart {...volumeChart} summary={null} />
        </div>
      </Card>
    </div>
  )
}
