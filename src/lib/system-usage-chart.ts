import type { DashboardWidget } from "./tracer/dashboards"
import type {
  SemanticMemberAnnotation,
  SemanticResult,
} from "./semantic/result"
import type { UsageMonth } from "./system-overview"

const measures = ["usage.traces", "usage.spans"]
const annotation = (name: string, title: string): SemanticMemberAnnotation => ({
  name,
  title,
  kind: "measure",
  type: "number",
  format: "integer",
  aggregation: "sum",
  description: `Retained ${title.toLowerCase()} by start month, independent of billing.`,
  definition:
    "Counts of stored records grouped by their start timestamp in UTC calendar months.",
  metricVersion: "2",
  limitations: [
    "Deleted records and records without a valid start timestamp are excluded.",
  ],
})

/** Adapt the protected CMS snapshot to the dashboard's presentation contract.
 * This does not expose or execute a cross-organization semantic query. */
export function systemUsageChart(months: UsageMonth[], capturedAt: string) {
  const start = `${months[0]?.month ?? capturedAt.slice(0, 7)}-01T00:00:00Z`
  const end = new Date(
    `${months.at(-1)?.month ?? capturedAt.slice(0, 7)}-01T00:00:00Z`
  )
  end.setUTCMonth(end.getUTCMonth() + 1)
  const widget: DashboardWidget = {
    id: "organization-monthly-usage",
    title: "Monthly usage",
    type: "stacked",
    width: 3,
    query: {
      measures,
      dimensions: [],
      timeDimensions: [
        {
          dimension: "usage.month",
          granularity: "month",
          dateRange: [start, end.toISOString()],
        },
      ],
      filters: [],
      segments: [],
      order: [["usage.month", "asc"]],
      timezone: "UTC",
      limit: Math.max(1, months.length),
      offset: 0,
      total: true,
    },
  }
  const result: SemanticResult = {
    query: widget.query,
    data: months.map((month) => ({
      "usage.month": `${month.month}-01`,
      "usage.traces": month.traces,
      "usage.spans": month.spans,
    })),
    annotation: {
      measures: {
        "usage.traces": annotation("usage.traces", "Traces"),
        "usage.spans": annotation("usage.spans", "Spans"),
      },
      dimensions: {},
      segments: {},
      timeDimensions: {
        "usage.month": {
          name: "usage.month",
          title: "Month (UTC)",
          kind: "timeDimension",
          type: "date",
          description: "UTC calendar month.",
          definition:
            "The UTC calendar month of each record's start timestamp.",
          metricVersion: "2",
          limitations: [],
        },
      },
    },
    meta: {
      contractVersion: "datool-semantic-v2",
      requestId: "cms-usage-snapshot",
      generatedAt: capturedAt,
      asOf: capturedAt,
      metricVersions: { usage: "2" },
      quality: {
        status: "complete",
        warnings: [],
        limitations: [
          "Counts include retained records only; deletion reduces historical activity.",
        ],
      },
      page: { limit: widget.query.limit, offset: 0, total: months.length },
    },
  }
  return { widget, result }
}
