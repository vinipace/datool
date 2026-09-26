import { MetricDelta } from "@/components/ui/metric-delta"
import { formatDuration } from "./format"

export function EvalMetricDifference({
  value,
  baseline,
  format = "score",
}: {
  value: number | null | undefined
  baseline: number | null | undefined
  format?: "score" | "duration" | "number"
}) {
  if (value == null || !Number.isFinite(value)) return null
  if (baseline == null || !Number.isFinite(baseline))
    return (
      <span
        className="text-xs text-foreground-muted"
        title="No numeric baseline is available for this value"
      >
        No baseline
      </span>
    )
  const difference = value - baseline
  const rounded = Number(
    (difference * (format === "score" ? 100 : 1)).toFixed(2)
  )
  const improved = format === "duration" ? difference < 0 : difference > 0
  const text =
    rounded === 0
      ? "No change"
      : format === "duration"
        ? `${difference > 0 ? "+" : "−"}${formatDuration(Math.abs(difference))}`
        : `${rounded > 0 ? "+" : ""}${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}${format === "score" ? " pp" : ""}`
  return (
    <span className="shrink-0 text-xs" title={`${text} vs baseline`}>
      <MetricDelta
        tone={
          rounded === 0 || format === "number"
            ? "neutral"
            : improved
              ? "positive"
              : "negative"
        }
      >
        {text}
        <span className="sr-only"> vs baseline</span>
      </MetricDelta>
    </span>
  )
}
