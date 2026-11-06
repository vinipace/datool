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
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2 text-xs"
    >
      <span aria-label="Success rate" className="font-mono text-sm">
        <PercentageCell value={summary?.successRate} />
      </span>
      {summary ? (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {[
            ["passed", summary.passed],
            ["failed", summary.failed],
            ...(summary.pending ? [["pending", summary.pending]] : []),
            ...(summary.notRun ? [["not run", summary.notRun]] : []),
            ...(summary.unscored ? [["unscored", summary.unscored]] : []),
            ...(summary.cancelled ? [["cancelled", summary.cancelled]] : []),
          ].map(([label, count]) => (
            <div key={label} className="flex items-center gap-1.5">
              <dt className="text-foreground-muted">{label}</dt>
              <dd className="order-first font-mono tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="text-foreground-muted">Loading…</span>
      )}
    </section>
  )
}
