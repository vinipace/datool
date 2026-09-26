import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { Notice } from "@/components/ui/notice"
import { EvalRunProgress } from "./eval-run-progress"
import { PercentageCell } from "./percentage-cell"
import { ResultIcon } from "./result-icon"

function ScoreValue({ value }: { value: number | boolean | null }) {
  return typeof value === "boolean" ? (
    <ResultIcon success={value} />
  ) : value != null && (value < 0 || value > 1) ? (
    <span className="tabular-nums">{value.toLocaleString()}</span>
  ) : (
    <PercentageCell value={value} />
  )
}

function ScorerSummary({
  name,
  value,
}: {
  name: string
  value: number | boolean | null
}) {
  return (
    <li className="space-y-2 py-3">
      <h3 className="text-sm leading-5">{name}</h3>
      <ScoreValue value={value} />
    </li>
  )
}

export function EvalRunSummary({ run }: { run: EvalRunDetail }) {
  const extraMetrics = run.scorerProgress?.length
    ? (run.scores?.filter(
        (score) =>
          !run.scorerProgress!.some((scorer) => scorer.name === score.name)
      ) ?? [])
    : []
  return (
    <div className="space-y-5">
      <section aria-label="Experiment summary" className="space-y-3">
        <div className="flex flex-col items-start">
          <EvalRunProgress run={run} />
          <h1 className="min-w-0 text-sm leading-5 font-medium">
            {run.name ?? "Untitled experiment"}
          </h1>
        </div>
        {(run.metadata.interruption || run.metadata.executionError) && (
          <Notice variant="warning">
            {String(run.metadata.executionError ?? run.metadata.interruption)}
          </Notice>
        )}
        {run.score != null && (
          <div className="space-y-2 border-t border-border pt-3">
            <h2 className="text-xs text-foreground-muted">Average score</h2>
            <PercentageCell value={run.score} />
          </div>
        )}
      </section>
      <section
        aria-label="Scorer progress"
        className="border-t border-border pt-4"
      >
        <h2 className="text-xs font-medium text-foreground-muted">Scorers</h2>
        {run.scorerProgress?.length ? (
          <ul className="divide-y divide-border">
            {run.scorerProgress.map((scorer) => (
              <ScorerSummary
                key={scorer.evaluatorId}
                name={scorer.name}
                value={
                  run.scores?.find((score) => score.name === scorer.name)
                    ?.value ?? scorer.score
                }
              />
            ))}
          </ul>
        ) : run.scores?.length ? (
          <ul className="divide-y divide-border">
            {run.scores.map((score) => (
              <ScorerSummary
                key={score.name}
                name={score.name}
                value={score.value}
              />
            ))}
          </ul>
        ) : (
          <p className="pt-3 text-xs text-foreground-muted">
            {run.evaluatorIds.length
              ? "Waiting for scorer progress…"
              : "No scorers selected."}
          </p>
        )}
      </section>
      {extraMetrics.length > 0 && (
        <section
          aria-label="Additional metrics"
          className="space-y-3 border-t border-border pt-4"
        >
          <h2 className="text-xs font-medium text-foreground-muted">
            Additional metrics
          </h2>
          {extraMetrics.map((metric) => (
            <div key={metric.name} className="space-y-2">
              <h3 className="text-sm">{metric.name}</h3>
              <ScoreValue value={metric.value} />
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
