// Shared visual defaults for every dashboard chart.
export const dashboardChartStyle = {
  // Reserve 20% on each side; bars fill the remaining category band.
  barCategoryGap: "20%",
  barRadius: 6,
  metricLineOpacity: 0.65,
  metricAreaOpacity: 0.14,
  lineAreaOpacity: 0.12,
  gridOpacity: 0.12,
  height: 196,
  bodyClassName: "flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-2 pb-2",
  legendClassName: "space-y-1.5 px-3 text-xs",
} as const

const colors = [
  "var(--data-series-1)",
  "var(--data-series-2)",
  "var(--data-series-3)",
  "var(--data-series-4)",
]

export function dashboardSeriesColor(index: number) {
  return colors[index % colors.length]
}

export function dashboardBarColor(index: number) {
  return `color-mix(in oklab, ${dashboardSeriesColor(index)}, var(--foreground) var(--data-bar-lift))`
}

export function lineSeriesColor(index: number) {
  return index === 0 ? "var(--foreground)" : dashboardSeriesColor(index - 1)
}

/** A metric's meaning stays the same regardless of its current value or delta. */
export function metricTone(member: string) {
  const metric = member.split(".").at(-1)
  if (
    [
      "erroredCount",
      "errorCount",
      "failedCount",
      "failedCheckCount",
      "explicitFailCount",
      "errorRate",
    ].includes(metric ?? "")
  )
    return "destructive"
  if (
    ["completedCount", "explicitPassCount", "explicitPassRate"].includes(
      metric ?? ""
    )
  )
    return "success"
  return "neutral"
}

/** Metric histories use meaning, independently of the comparison's direction. */
export function metricSeriesColor(member: string) {
  const tone = metricTone(member)
  if (tone === "destructive") return "var(--destructive)"
  if (tone === "success") return "var(--success)"
  const metric = member.split(".").at(-1)
  if (metric === "count" || metric?.endsWith("Count"))
    return "var(--foreground)"
  return seriesColor(member, 0)
}

export function seriesColor(member: string, index: number) {
  if (member.endsWith("llmCount") || member.includes("mean"))
    return dashboardSeriesColor(1)
  if (member.endsWith("otherCount")) return dashboardSeriesColor(0)
  if (member.includes("p95") || member.endsWith("toolCount"))
    return "var(--data-series-emphasis)"
  if (member.includes("cache")) return dashboardSeriesColor(3)
  return dashboardSeriesColor(index)
}
