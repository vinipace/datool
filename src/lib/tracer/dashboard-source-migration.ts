import type { SemanticCatalogModelMetadata } from "@/src/lib/semantic/catalog"
import type { SemanticFilter } from "@/src/lib/semantic/query"
import type { DashboardWidget } from "./dashboards"

/** Pure preview: a saved widget changes only after the user applies this proposal. */
export function previewDashboardSourceMigration(
  widget: DashboardWidget,
  catalog: readonly SemanticCatalogModelMetadata[]
) {
  const source = widget.query.measures[0]?.split(".")[0]
  if (!["logs", "scores", "evalQuality"].includes(source)) return null
  const latency = widget.query.measures.some((m) =>
    ["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
  )
  const target =
    source === "logs" ? (latency ? "traces" : "spans") : "evalResults"
  const model = catalog.find((m) => m.name === target)
  if (!model) return null
  const map = (member: string) =>
    member
      .replace(new RegExp(`^${source}[.]`), `${target}.`)
      .replace(/\.meanLatencyMs$/, ".meanDurationMs")
      .replace(/\.p95LatencyMs$/, ".p95DurationMs")
      .replace(/\.evalRunId$/, ".runId")
  const filter = (f: SemanticFilter): SemanticFilter =>
    "member" in f
      ? { ...f, member: map(f.member) }
      : "and" in f
        ? { and: f.and.map(filter) }
        : { or: f.or.map(filter) }
  const query = {
    ...widget.query,
    measures: widget.query.measures.map(map),
    dimensions: widget.query.dimensions.map(map),
    timeDimensions: widget.query.timeDimensions.map((t) => ({
      ...t,
      dimension: map(t.dimension),
    })),
    filters: widget.query.filters.map(filter),
    having: widget.query.having?.map((f) => ({ ...f, member: map(f.member) })),
    segments: widget.query.segments.map(map),
    order: widget.query.order.map(
      ([m, d]) => [map(m), d] as [string, "asc" | "desc"]
    ),
  }
  const names = new Set(model.members.map((m) => m.name))
  const used = [
    ...query.measures,
    ...query.dimensions,
    ...query.timeDimensions.map((t) => t.dimension),
    ...query.segments,
    ...query.order.map(([m]) => m),
    ...(query.having ?? []).map((f) => f.member),
  ]
  const visit = (fs: SemanticFilter[]) => {
    for (const f of fs) {
      if ("member" in f) used.push(f.member)
      else visit("and" in f ? f.and : f.or)
    }
  }
  visit(query.filters)
  const unsupported = used.filter((m) => !names.has(m))
  if (
    latency &&
    widget.query.measures.some(
      (m) => !["logs.meanLatencyMs", "logs.p95LatencyMs"].includes(m)
    )
  )
    unsupported.push(
      "Mixed request latency and span usage: split into separate widgets"
    )
  return {
    source: catalog.find((m) => m.name === source)?.source?.title ?? source,
    target: model.source?.title ?? target,
    before: widget.query,
    after: query,
    unsupported,
    notes:
      source === "evalQuality"
        ? [
            "Includes historical results without saved attribution. Totals can increase; missing context appears as Unknown.",
            "Saved operation groups can overlap. Model grouping without an operation uses the complete saved case model set.",
          ]
        : source === "scores"
          ? [
              "Operation and model dimensions use saved evaluation-time context. Current trace membership is no longer used; historical missing context appears as Unknown.",
              "All persisted scorer executions remain in the population.",
            ]
          : [
              latency
                ? "Request latency keeps terminal request durations and trace-start selection."
                : "Usage keeps span-start selection and eligible recorded LLM quotes. Empty count populations return zero.",
            ],
    widget: { ...widget, query, series: widget.series?.map(map) },
  }
}
