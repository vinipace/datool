"use client"

import { useState } from "react"
import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { Button } from "@/components/ui/button"
import { DonutProgress } from "@/components/ui/donut-progress"
import { SegmentedProgress } from "@/components/ui/segmented-progress"
import { ExecutionStatus } from "@/components/ui/execution-status"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

const states = [
  { key: "completed", label: "Completed", className: "text-success" },
  { key: "error", label: "Errors", className: "text-destructive" },
  { key: "skipped", label: "Skipped", className: "text-warning" },
  { key: "running", label: "Running", className: "text-info" },
  { key: "queued", label: "Queued", className: "text-foreground-subtle" },
] as const

export function EvalRunProgress({ run }: { run: EvalRunDetail }) {
  const [open, setOpen] = useState(false)
  const expected = run.targetCount * run.evaluatorIds.length
  const hasBreakdown = Boolean(run.scorerProgress?.length)
  const counts = states.map((state) => ({
    ...state,
    value:
      run.scorerProgress?.reduce((sum, scorer) => sum + scorer[state.key], 0) ??
      0,
  }))
  const recorded = counts.reduce((sum, state) => sum + state.value, 0)
  const total = Math.max(expected, recorded, run.resultCount)
  const finished = hasBreakdown
    ? counts.slice(0, 3).reduce((sum, state) => sum + state.value, 0)
    : run.resultCount
  const segments: { label: string; value: number; className: string }[] =
    hasBreakdown
      ? counts
      : [
          {
            label: "Finished",
            value: finished,
            className: "text-foreground-muted",
          },
        ]
  const pending = total - (hasBreakdown ? recorded : finished)
  if (pending > 0)
    segments.push({
      label: "Pending",
      value: pending,
      className: "text-foreground-subtle",
    })
  const status =
    run.status === "failed"
      ? "error"
      : run.status === "cancelled"
        ? "skipped"
        : run.status
  const statusLabel =
    run.status === "failed"
      ? "Failed"
      : run.status === "cancelled"
        ? "Cancelled"
        : undefined

  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={150}
        render={
          <Button variant="ghost" className="-mt-1 h-4 w-10 p-0" />
        }
        aria-label={`Scoring progress details: ${finished} of ${total} finished`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SegmentedProgress
          value={finished}
          max={total}
          label="Scoring progress"
          segments={segments}
        />
      </HoverCardTrigger>
      <HoverCardContent
        aria-label="Scoring progress details"
        side="right"
        align="start"
        className="space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Scoring progress</h2>
          <ExecutionStatus status={status} label={statusLabel} />
        </div>
        <p className="text-xs text-foreground-muted">
          {run.targetCount} {run.targetCount === 1 ? "target" : "targets"} ·{" "}
          {run.evaluatorIds.length}{" "}
          {run.evaluatorIds.length === 1 ? "scorer" : "scorers"}
        </p>
        <div className="flex items-center gap-4">
          <DonutProgress
            value={finished}
            max={total}
            label="Scoring completion"
            segments={segments}
          />
          <dl className="min-w-0 flex-1 space-y-2 text-xs">
            <div className="flex justify-between gap-4 font-medium">
              <dt>Finished scorer runs</dt>
              <dd className="tabular-nums">
                {finished} of {total}
              </dd>
            </div>
            {segments
              .filter((segment) => segment.value > 0)
              .map((segment) => (
                <div key={segment.label} className="flex justify-between gap-4">
                  <dt className="flex items-center gap-2 text-foreground-muted">
                    <span
                      aria-hidden="true"
                      className={`size-2 rounded-full bg-current ${segment.className}`}
                    />
                    {segment.label}
                  </dt>
                  <dd className="tabular-nums">{segment.value}</dd>
                </div>
              ))}
          </dl>
        </div>
        {total === 0 && (
          <p className="text-xs text-foreground-muted">
            This run has no scorer executions.
          </p>
        )}
        {run.execution?.stalled && (
          <p className="text-xs text-warning">
            Progress has stalled. Check the worker and target execution details.
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
