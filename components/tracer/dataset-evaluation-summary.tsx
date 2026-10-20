import type { DatasetEvaluationSummary } from "@/src/lib/tracer/contracts"
import { PercentageCell } from "./percentage-cell"

export function DatasetEvaluationSummary({
  summary,
}: {
  summary?: DatasetEvaluationSummary
}) {
  return (
    <section
      aria-label="Test results summary"
      className="shrink-0 border-b border-border px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="text-xs text-foreground-muted">Success rate</div>
          <div className="mt-1 font-mono text-2xl">
            <PercentageCell value={summary?.successRate} />
          </div>
        </div>
        {summary ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {[
              ["Passed", summary.passed],
              ["Failed", summary.failed],
              ["Pending", summary.pending],
              ["Not run", summary.notRun],
              ...(summary.unscored ? [["Unscored", summary.unscored]] : []),
              ...(summary.cancelled ? [["Cancelled", summary.cancelled]] : []),
            ].map(([label, count]) => (
              <div key={label}>
                <dt className="text-xs text-foreground-muted">{label}</dt>
                <dd className="mt-1 font-mono tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="text-xs text-foreground-muted">
            Loading results…
          </span>
        )}
      </div>
    </section>
  )
}
