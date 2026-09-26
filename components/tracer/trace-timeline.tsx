"use client"

import * as React from "react"
import { TraceViewer } from "@/components/ui/datool/trace-viewer"
import type { RenderSpanIcon } from "@/components/ui/datool/trace-viewer/types"
import type { TraceOverview } from "@/src/lib/tracer/contracts"
import { toViewerTrace, toViewerRun, runTimelineKey } from "./trace-viewer-data"
import { SpanKindIcon } from "./span-kind-icon"
import type { TraceIconKind } from "./trace-icon-kind"

function TimelineSpanIcon({ kind }: { kind: TraceIconKind }) {
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useLayoutEffect(() => {
    const icon = ref.current?.firstElementChild
    const span = ref.current?.closest<HTMLElement>("[data-span-id]")
    if (!icon || !span) return

    // Follow the existing icon palette without duplicating its color definitions.
    span.style.setProperty(
      "--span-icon-color",
      getComputedStyle(icon).backgroundColor
    )
    return () => {
      span.style.removeProperty("--span-icon-color")
    }
  })

  return (
    <span ref={ref} className="contents">
      <SpanKindIcon kind={kind} />
    </span>
  )
}

export function TraceTimeline({
  trace,
  selectedSpanId,
  onSelectSpan,
}: {
  trace: TraceOverview
  selectedSpanId: string | null
  onSelectSpan: (spanId: string | null) => void
}) {
  const viewerTrace = React.useMemo(() => toViewerTrace(trace), [trace])
  const spanKinds = React.useMemo(
    () => new Map(trace.spans.map((span) => [span.id, span.kind])),
    [trace.spans]
  )
  const renderSpanIcon = React.useCallback<RenderSpanIcon>(
    (span) => {
      const kind = spanKinds.get(span.spanId)
      return kind ? <TimelineSpanIcon kind={kind} /> : null
    },
    [spanKinds]
  )

  return (
    <section
      aria-label="Trace timeline"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <div className="min-h-0 flex-1">
        {viewerTrace.spans.length ? (
          <TraceViewer
            hideMiniMap
            hideSearchBar
            withPanel={false}
            selectedSpanId={selectedSpanId}
            onSpanSelect={onSelectSpan}
            renderSpanIcon={renderSpanIcon}
            height="100%"
            isLive={trace.status === "running"}
            trace={viewerTrace}
          />
        ) : (
          <div
            role="status"
            className="flex h-full items-center justify-center p-6 text-sm text-foreground-muted"
          >
            No captured span timing is available yet.
          </div>
        )}
      </div>
    </section>
  )
}

export function RunTraceTimeline({
  traces,
  selectedTraceId,
  selectedSpanId,
  onSelect,
}: {
  traces: TraceOverview[]
  selectedTraceId: string
  selectedSpanId: string | null
  onSelect: (traceId: string, spanId: string | null) => void
}) {
  const run = React.useMemo(() => toViewerRun(traces), [traces])
  const renderSpanIcon = React.useCallback<RenderSpanIcon>(
    (span) => <TimelineSpanIcon kind={span.resource as TraceIconKind} />,
    []
  )
  return (
    <section
      aria-label="Run timeline"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <TraceViewer
        hideMiniMap
        hideSearchBar
        withPanel={false}
        height="100%"
        trace={run.trace}
        isLive={traces.some((trace) => trace.status === "running")}
        selectedSpanId={runTimelineKey(selectedTraceId, selectedSpanId)}
        renderSpanIcon={renderSpanIcon}
        onSpanSelect={(id) => {
          const target = id ? run.targets.get(id) : undefined
          if (target) onSelect(target.traceId, target.spanId)
        }}
      />
    </section>
  )
}
