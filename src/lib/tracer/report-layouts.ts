import type { Report } from "./reports"
import {
  reportPresentationSchema,
  reportPresentationResult,
  type ReportPresentation,
} from "./report-presentation"
import type { ReportComparison } from "./report-layout-contract"
import { defaultMetricTrendDirection } from "./dashboard-metric-comparison"
import {
  formatDisplayValue,
  presentDashboardResult,
} from "./dashboard-presentation"

type CapturedReport = Pick<Report, "config" | "snapshot">

/** Discover only complete, unambiguous categorical results. Never aggregate rows. */
export function defaultReportComparison(
  report: CapturedReport
): ReportComparison | undefined {
  const choices: ReportComparison[] = []
  for (const widget of report.config.widgets) {
    if (widget.type === "text") continue
    const position = report.snapshot.positions.find((p) => p.id === widget.id)
    if (position?.cohorts.length !== 1) continue
    const result = presentDashboardResult(
      report.snapshot.results[position.cohorts[0].result],
      widget.presentation
    )
    const [dimension] = result.query.dimensions
    if (
      result.query.dimensions.length !== 1 ||
      result.query.timeDimensions.some((t) => t.granularity) ||
      result.data.length < 2 ||
      result.data.length > 8
    )
      continue
    const values = result.data.map((row) => row[dimension])
    if (
      values.some((value) => typeof value !== "string") ||
      new Set(values).size !== values.length
    )
      continue
    const candidates = (values as string[]).map((value) => ({
      value,
      label:
        formatDisplayValue(value, result.annotation.dimensions[dimension]) ??
        value,
    }))
    const numeric = result.query.measures.filter(
      (member) => result.annotation.measures[member]?.type === "number"
    )
    const rates = numeric.filter((member) =>
      ["ratio", "USD", "ms"].includes(
        result.annotation.measures[member]?.unit ?? ""
      )
    )
    const metrics = (rates.length ? rates : numeric)
      .slice(0, 20)
      .map((member) => {
        const direction = ["precision", "recall", "f1", "accuracy"].some(
          (name) => member === `evalClassification.${name}`
        )
          ? "increase"
          : defaultMetricTrendDirection(member)
        return {
          member,
          label: result.annotation.measures[member].title,
          direction:
            direction === "increase"
              ? ("higher" as const)
              : direction === "decrease"
                ? ("lower" as const)
                : ("neutral" as const),
        }
      })
    if (metrics.length)
      choices.push({
        widgetId: widget.id,
        dimension,
        candidates,
        baseline: candidates[0].value,
        candidate: candidates.at(-1)!.value,
        metrics,
      })
  }
  return choices.sort((a, b) => b.metrics.length - a.metrics.length)[0]
}

/** A conservative reading composition for UI-created reports; preserves every widget. */
export function defaultReportPresentation(
  report: CapturedReport
): ReportPresentation {
  const widgets = report.config.widgets
  const sections = Array.from(
    { length: Math.ceil(widgets.length / 2) },
    (_, index) => ({
      id: `section-${index + 1}`,
      title: widgets[index * 2].title || `Results ${index + 1}`,
      description: "Captured results for this report.",
      widgets: widgets
        .slice(index * 2, index * 2 + 2)
        .map((widget) => ({ widgetId: widget.id, width: "full" as const })),
    })
  )
  return reportPresentationSchema.parse({
    schemaVersion: 1,
    recipe: "evaluation-story",
    eyebrow: "Evaluation report",
    title: report.config.name,
    summary:
      report.config.description || "Results captured for the selected scope.",
    disclosure:
      "This report uses a fixed capture. Changing the layout does not refresh its data.",
    metrics: [],
    sections,
  })
}

export function reportComparisonRows(
  report: CapturedReport,
  comparison: ReportComparison
) {
  const widget = report.config.widgets.find(
    (item) => item.id === comparison.widgetId
  )
  const result = presentDashboardResult(
    reportPresentationResult(report, comparison.widgetId),
    widget?.type !== "text" ? widget?.presentation : undefined
  )
  return {
    result,
    rows: new Map(
      comparison.candidates.map((candidate) => [
        candidate.value,
        result.data.find(
          (row) => row[comparison.dimension] === candidate.value
        )!,
      ])
    ),
  }
}

export function reportMetricChange(
  value: unknown,
  baseline: unknown,
  direction: "higher" | "lower" | "neutral",
  ratio: boolean
) {
  if (
    typeof value !== "number" ||
    typeof baseline !== "number" ||
    !Number.isFinite(value) ||
    !Number.isFinite(baseline)
  )
    return null
  const difference = value - baseline
  const amount = ratio
    ? difference * 100
    : baseline === 0
      ? difference
      : (difference / Math.abs(baseline)) * 100
  return {
    difference,
    amount,
    unit: ratio ? "pp" : baseline === 0 ? "absolute" : "%",
    tone:
      difference === 0 || direction === "neutral"
        ? "neutral"
        : (direction === "higher" ? difference > 0 : difference < 0)
          ? "positive"
          : "negative",
  } as const
}

export function reportTargetStatus(
  value: unknown,
  target: number | undefined,
  direction: "higher" | "lower" | "neutral"
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "missing"
  if (target === undefined || direction === "neutral") return "unconfigured"
  return (direction === "higher" ? value >= target : value <= target)
    ? "met"
    : "missed"
}

export function reportBestValue(
  values: unknown[],
  direction: "higher" | "lower" | "neutral"
) {
  if (direction === "neutral") return null
  const numeric = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value)
  )
  if (!numeric.length) return null
  return direction === "higher" ? Math.max(...numeric) : Math.min(...numeric)
}
