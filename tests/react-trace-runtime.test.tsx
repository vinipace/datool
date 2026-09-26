import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "bun:test"
import { compileTraceView, traceViewCandidates } from "@/src/lib/tracer/trace-view-compiler"
import { evaluateTraceView } from "@/src/lib/tracer/trace-view-evaluate"
import { projectTraceViewData, type TraceViewData } from "@/src/lib/tracer/trace-view-contract"
import { reactViewInputSchema } from "@/src/lib/tracer/react-views"
import { DataTable } from "@/components/ui/view-data-table"
import { Card } from "@/components/ui/card"

const theme = '@theme { --color-foreground: black; --spacing: .25rem; --breakpoint-sm: 40rem; } @tailwind utilities;'
const trace = { id: "test", name: "Recorded result", input: {}, output: { count: 2 }, spans: [{ id: "span" }], scores: [{ name: "quality" }], spanStats: {}, nextSpanCursor: "cursor", nextScoreCursor: "cursor" } as unknown as TraceViewData

async function rejected(promise: Promise<unknown>, message?: string) {
  let error: unknown
  try { await promise } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  if (message) expect((error as Error).message).toContain(message)
}

describe("custom trace view compiler and sandbox contract", () => {
  test("supports imported React, shared components and legacy implicit React", async () => {
    for (const imports of ['', 'import * as React from "react";', 'import React from "react";']) {
      const compiled = await compileTraceView(`${imports} import { Card } from "@datool/ui"; export default function View({trace}: ViewProps) { const [count] = React.useState(2); return <Card>{trace.name}: {count}</Card> }`, theme, "test-build")
      const View = evaluateTraceView(compiled, React, { react: React, "@datool/ui": { Card } })
      expect(renderToStaticMarkup(<View trace={trace} />)).toContain("Recorded result: 2")
    }
  })
  test("compiles static Tailwind, conditionals, arbitrary values and template branches", async () => {
    const source = 'export default () => <div className={`p-4 ${true ? "text-foreground" : "sm:p-8"} w-[123px]`}/>'
    for (const candidate of ["p-4", "text-foreground", "sm:p-8", "w-[123px]"]) expect(traceViewCandidates(source)).toContain(candidate)
    const compiled = await compileTraceView(source, theme, "build")
    expect(compiled.css).toContain("123px")
    expect(compiled.css).toContain("40rem")
    expect(compiled.javascript).not.toContain("ViewProps")
  })
  test("rejects malformed code and unsupported or dynamic imports before saving", async () => {
    await rejected(compileTraceView('import x from "remote-library"; export default x', theme, "x"), "Unsupported import")
    await rejected(compileTraceView('export default () => import("react")', theme, "x"), "static imports")
    await rejected(compileTraceView('export default () => <div>', theme, "x"))
    const invalid = await compileTraceView('export const value = 1', theme, "x")
    expect(() => evaluateTraceView(invalid, React, { react: React })).toThrow("default React component")
    const require = await compileTraceView('const value = require("other"); export default () => null', theme, "x")
    expect(() => evaluateTraceView(require, React, { react: React })).toThrow("Unsupported import")
  })
  test("summary mode omits child payloads and persists with the view definition", () => {
    const summary = projectTraceViewData(trace, "summary")
    expect(summary).toEqual({ id: "test", name: "Recorded result", input: {}, output: { count: 2 } })
    expect(projectTraceViewData(trace, "full")).toBe(trace)
    const saved = reactViewInputSchema.parse({ name: "Summary", description: "", requirements: null, code: "export default () => null", dataMode: "summary" })
    expect(saved.dataMode).toBe("summary")
  })
  test("tables bound the rendered rows and expose a useful empty state", () => {
    const data = Array.from({length: 70}, (_, n) => ({ name: `record-${n}` }))
    const markup = renderToStaticMarkup(<DataTable data={data} columns={[{accessorKey:"name", header:"Name"}]} caption="Records" />)
    expect(markup.match(/record-\d+/g)).toHaveLength(50)
    expect(markup).toContain("Next")
    const empty = renderToStaticMarkup(<DataTable data={[]} columns={[]} caption="Records" emptyMessage="No matching records" />)
    expect(empty).toContain("No matching records")
  })
})
