import {
  reportCaptureSchema,
  type ReportInput,
} from "../../src/lib/tracer/reports"
import { reportDocumentSchema } from "../../src/lib/tracer/report-mdx"

/** Express query-focused fixtures as MDX without changing their analytics setup. */
export function captureFixtureDocument(value: unknown): ReportInput {
  const input = reportCaptureSchema.parse(value)
  for (const widget of input.config.widgets)
    if (!/^[a-zA-Z]/.test(widget.id)) widget.id = "w" + widget.id
  const sources: ReportInput["sources"] = {}
  const bindings: ReportInput["bindings"] = {}
  const mdx: string[] = []
  for (const widget of input.config.widgets) {
    if (widget.type === "text") {
      mdx.push(
        widget.content.replace(
          /\{\{evidence\.([^}]+)\}\}/g,
          '<Value binding="$1" />'
        )
      )
      continue
    }
    sources[widget.id] = {
      query: widget.query,
      presentation: widget.presentation,
    }
    const tag =
      widget.type === "matrix"
        ? "Matrix"
        : widget.type === "table"
          ? "Table"
          : "Chart"
    const strip = <T extends { widgetId: string }>(v: T) => {
      const { widgetId: _, ...rest } = v
      void _
      return rest
    }
    const props = {
      source: widget.id,
      ...(tag === "Chart" ? { type: widget.type } : {}),
      highlights: input.highlights
        ?.filter((v) => v.widgetId === widget.id)
        .map(strip),
      references: input.references
        ?.filter((v) => v.widgetId === widget.id)
        .map(strip),
    }
    mdx.push(
      `<${tag} ${Object.entries(props)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}={${JSON.stringify(v)}}`)
        .join(" ")} />`
    )
  }
  for (const b of input.bindings ?? []) {
    const { id, textWidgetId: _, source, baseline, ...rest } = b
    void _
    const selection = (s: typeof source) => {
      const { widgetId, ...fields } = s
      return { ...fields, source: widgetId }
    }
    bindings[id] = {
      ...rest,
      source: selection(source),
      ...(baseline ? { baseline: selection(baseline) } : {}),
    }
  }
  return {
    ...reportDocumentSchema.parse({
      name: input.config.name,
      description: input.config.description,
      mdx: mdx.join("\n\n"),
      sources,
      bindings,
    }),
    creationKey: input.creationKey,
  }
}
