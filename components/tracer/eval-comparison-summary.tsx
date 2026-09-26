import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { ComparisonDot } from "@/components/ui/comparison-series"
import { EvalMetricDifference } from "./eval-metric-difference"

type MetricValue = number | boolean | null | undefined

function formatValue(value: MetricValue, percentage: boolean) {
  if (value == null) return "—"
  if (typeof value === "boolean") return value ? "Pass" : "Fail"
  return percentage
    ? value.toLocaleString(undefined, {
        style: "percent",
        maximumFractionDigits: 1,
      })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function EvalComparisonSummary({
  baseline,
  runs,
}: {
  baseline: EvalRunDetail
  runs: EvalRunDetail[]
}) {
  const all = [baseline, ...runs]
  const metrics = [
    {
      name: "Average score",
      value: (run: EvalRunDetail): MetricValue => run.score,
    },
    ...[
      ...new Set(
        all.flatMap((run) => run.scores?.map((score) => score.name) ?? [])
      ),
    ].map((name) => ({
      name,
      value: (run: EvalRunDetail): MetricValue =>
        run.scores?.find((score) => score.name === name)?.value,
    })),
  ]
  return (
    <section
      aria-label="Run score comparison"
      className="space-y-4 border-t border-border pt-4"
    >
      <div className="space-y-1">
        <h2 className="text-xs font-medium">Scores</h2>
        <p className="text-xs leading-5 text-foreground-muted">
          Change vs baseline. pp = percentage points.
        </p>
      </div>
      {metrics.map((metric) => {
        const values = all.map(metric.value)
        const percentage = values.every(
          (value) =>
            value == null ||
            (typeof value === "number" && value >= 0 && value <= 1)
        )
        return (
          <section
            key={metric.name}
            aria-label={`${metric.name} comparison`}
            className="space-y-2"
          >
            <h3 className="text-xs text-foreground-muted">{metric.name}</h3>
            {all.map((run, index) => {
              const value = values[index]
              return (
                <div
                  key={run.id}
                  className="flex items-center gap-2 text-xs"
                  title={run.name ?? run.id}
                >
                  <ComparisonDot index={index} />
                  <span className="mr-auto text-foreground-muted">
                    {index === 0 ? "Baseline" : `Run ${index + 1}`}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatValue(value, percentage)}
                  </span>
                  {index > 0 && typeof value === "number" && (
                    <EvalMetricDifference
                      value={value}
                      baseline={
                        typeof values[0] === "number" ? values[0] : null
                      }
                      format={percentage ? "score" : "number"}
                    />
                  )}
                  {index > 0 &&
                    typeof value === "boolean" &&
                    typeof values[0] === "boolean" && (
                      <span className="text-foreground-muted">
                        {value === values[0] ? "No change" : "Changed"}
                      </span>
                    )}
                </div>
              )
            })}
          </section>
        )
      })}
      <p className="text-xs leading-5 text-foreground-muted">
        Overall run scores. Case-level changes are shown in the table.
      </p>
    </section>
  )
}
