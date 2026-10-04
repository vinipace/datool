import type { TraceDetail, TraceSummary } from "./contracts"

export const TRACE_VIEW_MODULES = ["react", "react/jsx-runtime", "@datool/ui", "@datool/charts"] as const
export type ViewSourceFormat = "react" | "mdx"
export type TraceViewModule = typeof TRACE_VIEW_MODULES[number]
export type TraceViewDataMode = "full" | "summary"
export type TraceViewData = TraceDetail | TraceSummary
export type CompiledTraceView = {
  buildId: string
  source: string
  format?: ViewSourceFormat
  javascript: string
  css: string
  modules: TraceViewModule[]
}

/** Root-only views do not receive model spans, scores, or navigation metadata. */
export function projectTraceViewData(trace: TraceViewData, mode: TraceViewDataMode): TraceViewData {
  if (mode === "full") return trace
  const { spans, scores, spanStats, nextSpanCursor, nextScoreCursor, ...root } = trace as TraceDetail
  void spans; void scores; void spanStats; void nextSpanCursor; void nextScoreCursor
  return root
}
