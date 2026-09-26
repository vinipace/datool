"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { EvalResult, JsonObject } from "@/src/lib/tracer/contracts"
import { ScorerTypeBadge } from "@/components/ui/scorer-type-badge"
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card"
import { PercentageCell } from "./percentage-cell"
import { ResultIcon } from "./result-icon"
import { SpanKindIcon } from "./span-kind-icon"

type ScoreDetails = {
  evaluatorName?: string | null
  score: number | null
  status?: string
  error?: string | null
  metadata?: JsonObject
} & Partial<
  Pick<EvalResult, "evaluatorVersion" | "reasoning" | "definition" | "passed">
>

export function ScoreExplanation({ result }: { result: ScoreDetails }) {
  const scorerType = result.definition?.config?.type ?? result.definition?.language
  const unavailable =
    result.metadata?.skipped === true ||
    result.error ||
    result.status === "error" ||
    result.status === "empty"
  const score =
    !unavailable && result.score != null && Number.isFinite(result.score)
      ? result.score
      : null
  const threshold = result.definition?.config?.threshold
  const hasThreshold = threshold != null && Number.isFinite(threshold)
  const difference =
    score != null && hasThreshold ? (score - threshold) * 100 : null
  const passed = unavailable ? null : result.passed
  const formatPercent = (value: number) =>
    value.toLocaleString(undefined, {
      style: "percent",
      maximumFractionDigits: 1,
    })

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <SpanKindIcon kind="score" />
        <p className="min-w-0 flex-1 text-sm leading-5 font-medium break-words">
          {result.evaluatorName ?? "Score"}
        </p>
        {scorerType && <ScorerTypeBadge type={scorerType} />}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-foreground-muted">Score</p>
          <p
            className={cn(
              "text-lg font-medium tabular-nums",
              passed === false && "text-destructive"
            )}
          >
            {score != null ? formatPercent(score) : "-"}
          </p>
        </div>
        {typeof passed === "boolean" && (
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium",
              passed ? "text-success" : "text-destructive"
            )}
          >
            <ResultIcon success={passed} />
            {passed ? "PASS" : "FAIL"}
          </span>
        )}
      </div>
      {hasThreshold && (
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div className="space-y-1">
            <dt className="text-foreground-muted">Pass threshold</dt>
            <dd className="tabular-nums">{formatPercent(threshold)}</dd>
          </div>
          {difference != null && (
            <div className="space-y-1">
              <dt className="text-foreground-muted">Difference</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  difference < 0 && "text-destructive"
                )}
              >
                {difference.toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                  signDisplay: "exceptZero",
                })}{" "}
                pp
              </dd>
            </div>
          )}
        </dl>
      )}
      <section className="space-y-1 border-t border-border pt-2">
        <h3 className="text-xs text-foreground-muted">Reasoning</h3>
        <p className="max-h-40 overflow-y-auto text-sm leading-5 break-words whitespace-pre-wrap">
          {result.reasoning?.trim() || "-"}
        </p>
      </section>
    </div>
  )
}

export function EvalScoreCell({ result }: { result?: ScoreDetails }) {
  const [open, setOpen] = useState(false)
  const value =
    result?.metadata?.skipped === true ? (
      <span title="Scorer skipped this trace" className="text-muted-foreground">
        Skipped
      </span>
    ) : result?.error || result?.status === "error" ? (
      <span
        role="status"
        title={result.error ?? "Scoring failed"}
        className="text-destructive"
      >
        Error
      </span>
    ) : typeof result?.metadata?.booleanScore === "boolean" ? (
      <ResultIcon success={result.metadata.booleanScore} />
    ) : (
      <PercentageCell
        value={result?.status === "empty" ? null : result?.score}
        tone={result?.passed === false ? "destructive" : "neutral"}
      />
    )
  if (!result) return value
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        render={
          <button
            type="button"
            aria-label={`Explain ${result.evaluatorName ?? "score"}`}
            className={cn(
              "block w-full cursor-help text-left",
              result.passed === false && "text-destructive"
            )}
            onClick={(event) => {
              event.stopPropagation()
              setOpen((value) => !value)
            }}
          />
        }
      >
        {value}
      </HoverCardTrigger>
      <HoverCardContent
        className="max-h-[70dvh] overflow-y-auto p-3"
        align="start"
      >
        <ScoreExplanation result={result} />
      </HoverCardContent>
    </HoverCard>
  )
}
