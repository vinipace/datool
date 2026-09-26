import type * as React from "react"
import type { CompiledTraceView, TraceViewData } from "./trace-view-contract"

/** Evaluate inside the sandbox only. The inner scope lets imports shadow legacy React. */
export function evaluateTraceView(artifact: CompiledTraceView, react: typeof React, modules: Record<string, unknown>) {
  const exports: { default?: React.ComponentType<{ trace: TraceViewData }> } = {}
  new Function("React", "exports", "require", `return (function(exports, require) {${artifact.javascript}\n})(exports, require)`)(react, exports, (name: string) => {
    if (!Object.hasOwn(modules, name) || !modules[name]) throw new Error(`Unsupported import: ${name}. Use a static import from react, @datool/ui or @datool/charts.`)
    return modules[name]
  })
  if (typeof exports.default !== "function") throw new Error("Export a default React component receiving { trace }.")
  return exports.default
}
