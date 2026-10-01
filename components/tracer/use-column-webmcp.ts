"use client"

import * as React from "react"
import type { ComputedColumnStore } from "@/src/lib/tracer/computed-column-store"
import type { EvalColumnLayout } from "@/src/lib/tracer/collection-column-order"
import {
  createColumnTools,
  registerColumnTools,
  type PageModelContext,
} from "@/src/lib/tracer/column-webmcp"

export function useColumnWebMcp(store: ComputedColumnStore | undefined, enabled: boolean, layout?: EvalColumnLayout) {
  React.useEffect(() => {
    if (!enabled || !store) return
    const context =
      (document as Document & { modelContext?: PageModelContext })
        .modelContext ??
      (navigator as Navigator & { modelContext?: PageModelContext })
        .modelContext
    if (!context?.registerTool) return
    return registerColumnTools(context, createColumnTools(store, layout), (error) =>
      console.warn("Eval column WebMCP registration failed:", error)
    )
  }, [store, enabled, layout])
}
