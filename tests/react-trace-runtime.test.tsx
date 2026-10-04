import * as React from "react"
import * as jsxRuntime from "react/jsx-runtime"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "bun:test"
import { compileTraceView, traceViewCandidates } from "@/src/lib/tracer/trace-view-compiler"
import { evaluateTraceView } from "@/src/lib/tracer/trace-view-evaluate"
import { projectTraceViewData, type TraceViewData } from "@/src/lib/tracer/trace-view-contract"
import type { PageViewProps } from "@/src/lib/tracer/react-page-views"
import { reactViewInputSchema } from "@/src/lib/tracer/react-views"
import { traceObjectViewInput } from "@/src/lib/tracer/object-views"
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
  test("MDX pages compile Markdown, JSX, GFM tables and expressions using live collection data", async () => {
    const source = `import { Card } from "@datool/ui"

# Loaded {props.rows.length} rows

<Card className="p-4">First: {props.rows[0]?.name ?? "empty"}</Card>

| Status | Count |
| --- | --- |
| Ready | 2 |

\`\`\`js
import dangerous from "remote-library"
\`\`\`
`
    const compiled = await compileTraceView(source, theme, "mdx-build", "mdx")
    const View = evaluateTraceView<PageViewProps<{ name: string }>>(compiled, React, { "react/jsx-runtime": jsxRuntime, "@datool/ui": { Card } })
    const props: PageViewProps<{ name: string }> = {
      rows: [{ name: "Recorded answer" }, { name: "Second answer" }],
      page: { resource: "traces", queryParams: {}, total: 2, isLoading: false, isRefreshing: false, hasMore: false, isLoadingMore: false, error: null },
      openTrace: () => {}, refresh: () => {}, loadMore: () => {},
    }
    const markup = renderToStaticMarkup(<View {...props} />)
    expect(markup).toContain("<h1>Loaded 2 rows</h1>")
    expect(markup).toContain("First: Recorded answer")
    expect(markup).toContain("<table>")
    expect(markup).toContain("<code class=\"language-js\">")
    expect(renderToStaticMarkup(<View {...props} rows={[]} />)).toContain("First: empty")
    expect(compiled.css).toContain("padding:")
    await rejected(compileTraceView("<Card>", theme, "x", "mdx"))
    await rejected(compileTraceView('import x from "remote-library"\n\n# Page', theme, "x", "mdx"), "Unsupported import")
    await rejected(compileTraceView('{import("react")}', theme, "x", "mdx"), "static imports")
  })
  test("supports imported React, shared components and legacy implicit React", async () => {
    for (const imports of ['', 'import * as React from "react";', 'import React from "react";']) {
      const compiled = await compileTraceView(`${imports} import { Card } from "@datool/ui"; export default function View({trace}: ViewProps) { const [count] = React.useState(2); return <Card>{trace.name}: {count}</Card> }`, theme, "test-build")
      const View = evaluateTraceView(compiled, React, { react: React, "@datool/ui": { Card } })
      expect(renderToStaticMarkup(<View {...traceObjectViewInput(trace)} trace={trace} />)).toContain("Recorded result: 2")
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
