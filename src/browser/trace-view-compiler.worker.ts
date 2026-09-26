import { compileTraceView } from "../lib/tracer/trace-view-compiler"
declare const TRACE_VIEW_THEME: string
declare const TRACE_VIEW_BUILD_ID: string
self.onmessage = async (event: MessageEvent<{ source: string }>) => {
  try { self.postMessage({ artifact: await compileTraceView(event.data.source, TRACE_VIEW_THEME, TRACE_VIEW_BUILD_ID) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
