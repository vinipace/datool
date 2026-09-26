"use client"

import * as React from "react"

import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { buildHistogram, type TraceTimeRange } from "./trace-list-utils"

function formatRangeLabel(timestamp: number, includeDate: boolean) {
  return new Intl.DateTimeFormat(undefined, {
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    month: includeDate ? "short" : undefined,
  }).format(new Date(timestamp))
}

export function TraceListHistogram({
  now,
  timeRange,
  traces,
}: {
  now: number
  timeRange: TraceTimeRange
  traces: TraceSummary[]
}) {
  const bins = React.useMemo(
    () => buildHistogram({ now, timeRange, traces }),
    [now, timeRange, traces]
  )
  const maxCount = Math.max(1, ...bins.map((bin) => bin.count))
  const start = bins.at(0)?.start ?? now
  const end = bins.at(-1)?.end ?? now
  const includesDate = end - start >= 24 * 60 * 60 * 1_000

  return (
    <section
      aria-label="Visible trace distribution over time"
      className="my-2 h-[76px] rounded-md bg-muted px-2 pt-1.5"
    >
      <p className="sr-only">
        {traces.length} visible trace{traces.length === 1 ? "" : "s"}{" "}
        distributed across the selected time range.
      </p>
      <div className="flex h-12 items-end gap-px border-b border-border-strong/90">
        {bins.map((bin, index) => {
          const height =
            bin.count === 0
              ? "0px"
              : `${Math.max(12, Math.round((bin.count / maxCount) * 100))}%`
          return (
            <span
              aria-hidden="true"
              className="min-w-0 flex-1 bg-data-series-primary transition-[height] duration-150"
              key={`${bin.start}:${index}`}
              style={{ height }}
              title={`${bin.count} trace${bin.count === 1 ? "" : "s"} between ${formatRangeLabel(bin.start, includesDate)} and ${formatRangeLabel(bin.end, includesDate)}`}
            />
          )
        })}
      </div>
      <div className="flex items-center justify-between px-0.5 pt-1 text-[10px] text-empty-foreground tabular-nums">
        <span>{formatRangeLabel(start, includesDate)}</span>
        <span>{formatRangeLabel(end, includesDate)}</span>
      </div>
    </section>
  )
}
