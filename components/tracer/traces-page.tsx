"use client"

import * as React from "react"
import { CircleDashed } from "lucide-react"

import { TraceListWorkspace } from "./trace-list"

/**
 * The URL-aware workspace is kept beneath Suspense because it reads trace and
 * span query parameters through Next's client navigation hooks.
 */
export function TracesPage() {
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-[calc(100dvh-3rem)] items-center justify-center gap-2 bg-background text-sm text-foreground-subtle">
          <CircleDashed className="size-4 animate-spin" />
          Loading trace logs
        </div>
      }
    >
      <TraceListWorkspace />
    </React.Suspense>
  )
}

export { TraceDetailPage } from "./trace-inspector"
