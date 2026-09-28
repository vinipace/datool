import { z } from "zod"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMdx from "remark-mdx"
import remarkGfm from "remark-gfm"
import { parseDocument, stringify } from "yaml"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  dashboardDataWidgetSchema,
  type DashboardInput,
  type DashboardWidget,
} from "./dashboards"
import { dashboardPresentationSchema } from "./dashboard-presentation"
import { reportBindingSchema, type ReportBinding } from "./report-evidence"
import { reportComparisonSchema } from "./report-layout-contract"
import {
  reportPresentationSchema,
  validateReportPresentation,
  reportPresentationText,
} from "./report-presentation"
import {
  reportHighlightSchema,
  reportReferenceSchema,
} from "./report-highlights"
import { reportMdxClasses } from "./report-mdx-classes"
import type { Report } from "./reports"

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().min(1).max(4000)
const selection = reportBindingSchema.shape.source
  .omit({ widgetId: true })
  .extend({ source: id })
export const mdxBindingSchema = z
  .object(reportBindingSchema.shape)
  .omit({ id: true, textWidgetId: true, source: true, baseline: true })
  .extend({ source: selection, baseline: selection.optional() })
  .refine(
    (v) => (v.operation === "value") === !v.baseline,
    "A baseline is required only for calculations."
  )
export const reportDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(1000).default(""),
    mdx: z.string().min(1).max(200000),
    sources: z
      .record(
        id,
        z
          .object({
            query: semanticQuerySchema,
            presentation: dashboardPresentationSchema.optional(),
          })
          .strict()
      )
      .default({}),
    bindings: z.record(id, mdxBindingSchema).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Object.keys(v.sources).length > 20)
      ctx.addIssue({ code: "custom", message: "Use at most 20 named sources." })
    if (Object.keys(v.bindings).length > 100)
      ctx.addIssue({
        code: "custom",
        message: "Use at most 100 evidence bindings.",
      })
  })
export type ReportDocumentInput = z.infer<typeof reportDocumentSchema>

const className = z.string().max(2000).optional()
const common = { className }
const chart = {
  ...common,
  source: id,
  title: text.optional(),
  caption: text.optional(),
  series: z.array(z.string()).min(1).max(20).optional(),
  presentation: dashboardPresentationSchema.optional(),
  trendDirection: z.enum(["increase", "decrease", "neutral"]).optional(),
  height: z.enum(["small", "medium", "large"]).default("medium"),
  highlights: z
    .array(reportHighlightSchema.omit({ widgetId: true }))
    .max(40)
    .optional(),
  references: z
    .array(reportReferenceSchema.omit({ widgetId: true }))
    .max(20)
    .optional(),
}
const comparison = reportComparisonSchema.omit({ widgetId: true }).extend({
  source: id,
  title: text.optional(),
  description: text.optional(),
  ...common,
})
const progression =
  reportPresentationSchema.shape.sections.element.shape.progression
    .unwrap()
    .omit({ widgetId: true })
    .extend({ source: id, ...common })
/** One registry drives agent discovery and the server's prop validation. */
export const reportComponentSchemas = {
  ReportHeader: z
    .object({
      ...common,
      eyebrow: text.optional(),
      title: text,
      summary: text.optional(),
      disclosure: text.optional(),
    })
    .strict(),
  Metrics: z
    .object({ ...common, columns: z.number().int().min(1).max(4).default(3) })
    .strict(),
  Metric: z
    .object({
      ...common,
      binding: id,
      label: text,
      detail: text.optional(),
      tone: z.enum(["neutral", "positive", "warning"]).default("neutral"),
    })
    .strict(),
  Value: z.object({ binding: id }).strict(),
  Section: z
    .object({
      ...common,
      id,
      title: text,
      description: text.optional(),
      number: z.string().max(4).optional(),
    })
    .strict(),
  Details: z.object({ ...common, id, title: text }).strict(),
  Callout: z
    .object({
      ...common,
      tone: z.enum(["neutral", "positive", "warning"]).default("neutral"),
    })
    .strict(),
  Chart: z
    .object({
      ...chart,
      type: z.enum(["bar", "line", "stacked", "scatter", "donut"]),
    })
    .strict(),
  Matrix: z.object(chart).strict(),
  Table: z.object(chart).strict(),
  Comparison: comparison,
  Scorecard: comparison,
  Progression: progression,
} as const
export type ReportComponentName = keyof typeof reportComponentSchemas
export type MdxNode = {
  tag: string
  props: Record<string, unknown>
  children: MdxNode[]
  text?: string
  line: number
  column: number
  widgetId?: string
}
export type CompiledReportMdx = { version: 1; nodes: MdxNode[] }
export type ReportDiagnostic = {
  severity: "error" | "warning"
  message: string
  line: number
  column: number
  path?: string
}
export class ReportMdxError extends Error {
  constructor(readonly diagnostics: ReportDiagnostic[]) {
    super(
      diagnostics
        .map((d) => `Line ${d.line}:${d.column}: ${d.message}`)
        .join("\n")
    )
    this.name = "ReportMdxError"
  }
}
type SyntaxNode = {
  type: string
  value?: string
  name?: string
  children?: SyntaxNode[]
  attributes?: {
    type: string
    name?: string
    value?: string | { type: string; value: string } | null
  }[]
  position?: { start: { line: number; column: number } }
  depth?: number
  url?: string
  title?: string
  alt?: string
  ordered?: boolean
  start?: number
  lang?: string
  identifier?: string
}
const parser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm)
const classes = new Set(reportMdxClasses.split(/\s+/))
const htmlTags = new Set([
  "div",
  "span",
  "section",
  "header",
  "footer",
  "aside",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "del",
  "blockquote",
  "hr",
  "br",
  "a",
  "code",
  "pre",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
])
const containers = new Set([
  "ReportHeader",
  "Metrics",
  "Section",
  "Details",
  "Callout",
])
const inlineTags = new Set([
  "#text",
  "Value",
  "span",
  "strong",
  "em",
  "del",
  "a",
  "code",
  "br",
])
const blockHtmlTags = new Set([
  "div",
  "section",
  "header",
  "footer",
  "aside",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "pre",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
])
const inlineContainers = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
])
const voidHtmlTags = new Set(["br", "hr"])
const isBlockHtmlTag = (tag: string | undefined) =>
  Boolean(tag && blockHtmlTags.has(tag))
const containsTag = (node: MdxNode, target: string): boolean =>
  node.tag === target || node.children.some((child) => containsTag(child, target))
function fail(message: string, node?: Pick<MdxNode, "line" | "column">): never {
  throw new ReportMdxError([
    {
      severity: "error",
      message,
      line: node?.line ?? 1,
      column: node?.column ?? 1,
    },
  ])
}
function safeUrl(url: string) {
  return (
    /^(https?:\/\/|mailto:|#[a-zA-Z])/.test(url) &&
    !Array.from(url).some(
      (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127
    )
  )
}
export function reportComponentsCatalog() {
  return {
    version: 1,
    syntax:
      "Markdown, supported semantic HTML elements and registered JSX components. Props accept strings or JSON literals only. No imports, exports, JavaScript expressions, spreads, event handlers, raw styles or arbitrary HTML.",
    components: Object.entries(reportComponentSchemas).map(
      ([name, schema]) => ({
        name,
        props: z.toJSONSchema(schema, { io: "input" }) as Record<
          string,
          unknown
        >,
        children: containers.has(name),
      })
    ),
    htmlTags: [...htmlTags].sort(),
    classes: reportMdxClasses.split(/\s+/),
  }
}
export function parseReportMdx(mdx: string): CompiledReportMdx {
  let ast: SyntaxNode
  try {
    ast = parser.parse(mdx) as unknown as SyntaxNode
  } catch (e) {
    const error = e as { message: string; line?: number; column?: number }
    throw new ReportMdxError([
      {
        severity: "error",
        message: error.message,
        line: error.line ?? 1,
        column: error.column ?? 1,
      },
    ])
  }
  let count = 0
  const ids = new Set<string>()
  const definitions = new Map<string, SyntaxNode>()
  for (const n of ast.children ?? [])
    if (n.type === "definition") definitions.set(n.identifier!, n)
  const convert = (
    n: SyntaxNode,
    depth = 0,
    parentTag?: string
  ): MdxNode[] => {
    const loc = {
      line: n.position?.start.line ?? 1,
      column: n.position?.start.column ?? 1,
    }
    if (++count > 5000 || depth > 40)
      fail("Document exceeds the supported size or nesting depth.", loc)
    let tag = "",
      props: Record<string, unknown> = {}
    if (n.type === "definition") return []
    // remark-mdx represents standalone JSX written on one line as a
    // paragraph containing an mdxJsxTextElement. Treat a supported block
    // element as the paragraph itself so ordinary JSX such as
    // <h1>Title</h1> and <p>Summary</p> does not require a span wrapper.
    if (
      n.type === "paragraph" &&
      n.children?.length === 1 &&
      n.children[0].type === "mdxJsxTextElement" &&
      isBlockHtmlTag(n.children[0].name)
    )
      return convert(n.children[0], depth + 1, parentTag)
    if (n.type === "text" || n.type === "inlineCode")
      return [
        {
          tag: n.type === "text" ? "#text" : "code",
          props: {},
          children: [],
          text: n.value,
          ...loc,
        },
      ]
    if (n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") {
      if (!n.name) fail("Use a named element instead of a fragment.", loc)
      tag = n.name!
      if (!Object.hasOwn(reportComponentSchemas, tag) && !htmlTags.has(tag))
        fail(`Unknown report component: ${tag}`, loc)
      if (
        n.type === "mdxJsxTextElement" &&
        !inlineTags.has(tag) &&
        !isBlockHtmlTag(tag)
      )
        fail(`Place ${tag} on its own line, separated from prose.`, loc)
      for (const attr of n.attributes ?? []) {
        if (attr.type !== "mdxJsxAttribute" || !attr.name)
          fail("Spread attributes are not supported.", loc)
        if (Object.hasOwn(props, attr.name))
          fail(`Duplicate prop: ${attr.name}`, loc)
        let value: unknown = attr.value === null ? true : attr.value
        if (typeof attr.value === "object" && attr.value !== null) {
          try {
            value = JSON.parse(attr.value.value)
          } catch {
            fail(
              `Prop ${attr.name} must be a JSON literal; expressions are not supported.`,
              loc
            )
          }
        }
        if (["__proto__", "prototype", "constructor"].includes(attr.name))
          fail("Invalid property name.", loc)
        props[attr.name] = value
      }
      if (Object.hasOwn(reportComponentSchemas, tag)) {
        const result =
          reportComponentSchemas[tag as ReportComponentName].safeParse(props)
        if (!result.success)
          fail(
            `${tag}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            loc
          )
        props = result.data
        if (
          !containers.has(tag) &&
          (n.children ?? []).some((c) => c.type !== "text" || c.value?.trim())
        )
          fail(`${tag} does not accept children.`, loc)
      } else {
        const allowed = new Set([
          "className",
          "id",
          ...(tag === "a" ? ["href", "title"] : []),
        ])
        for (const [key, value] of Object.entries(props))
          if (!allowed.has(key) || typeof value !== "string")
            fail(`Unsupported ${tag} prop: ${key}`, loc)
        if (tag === "a" && (!props.href || !safeUrl(String(props.href))))
          fail("Links must use https, http, mailto or a document anchor.", loc)
      }
    } else {
      const tags: Record<string, string> = {
        paragraph: "p",
        heading: `h${n.depth}`,
        emphasis: "em",
        strong: "strong",
        delete: "del",
        blockquote: "blockquote",
        list: n.ordered ? "ol" : "ul",
        listItem: "li",
        thematicBreak: "hr",
        break: "br",
        link: "a",
        linkReference: "a",
        table: "table",
        tableRow: "tr",
        tableCell: "td",
        code: "pre",
      }
      tag = tags[n.type]
      if (!tag)
        fail(
          `Unsupported MDX syntax: ${n.type}. Use Markdown and registered components.`,
          loc
        )
      if (n.type === "code")
        return [
          {
            tag: "pre",
            props: {},
            children: [
              { tag: "code", props: {}, children: [], text: n.value, ...loc },
            ],
            ...loc,
          },
        ]
      if (n.type === "link" || n.type === "linkReference") {
        const url =
          n.type === "link" ? n.url : definitions.get(n.identifier!)?.url
        if (!url || !safeUrl(url)) fail("Invalid or unresolved link.", loc)
        props.href = url
      }
    }
    if (props.className)
      for (const token of String(props.className).split(/\s+/))
        if (!classes.has(token))
          fail(`Unsupported Tailwind class: ${token}`, loc)
    if (props.id) {
      const parsed = id.safeParse(props.id)
      if (!parsed.success || ids.has(String(props.id)))
        fail(`Invalid or duplicate document id: ${props.id}`, loc)
      ids.add(String(props.id))
    }
    const content = (n.children ?? []).flatMap((c) => {
      // remark-mdx represents a raw HTML list's children as one paragraph.
      // Flatten that parser-only wrapper before converting so valid markup
      // does not become an invalid <p><li>...</li></p> tree.
      if (
        (tag === "ul" || tag === "ol") &&
        c.type === "paragraph"
      )
        return (c.children ?? []).flatMap((child) =>
          convert(child, depth + 1, tag)
        )
      return convert(c, depth + 1, tag)
    })
    // Flow JSX elements that accept inline content are parsed with a
    // paragraph wrapper. Remove only that synthetic wrapper; multiple
    // paragraphs or a block child remain invalid and are rejected below.
    const normalizedContent =
      inlineContainers.has(tag) &&
      content.length === 1 &&
      content[0].tag === "p" &&
      n.children?.length === 1 &&
      n.children[0].type === "paragraph"
        ? content[0].children
        : content
    if (voidHtmlTags.has(tag) && normalizedContent.length)
      fail(`${tag} is a void element and cannot have children.`, loc)
    if (
      tag === "a" &&
      normalizedContent.some((child) => containsTag(child, "a"))
    )
      fail("Links cannot contain other links.", loc)
    if (
      [
        "p",
        "a",
        "span",
        "strong",
        "em",
        "del",
        "code",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].includes(tag) &&
      normalizedContent.some((child) => !inlineTags.has(child.tag))
    )
      fail(
        `${tag} accepts inline content only. Put block components outside it.`,
        loc
      )
    const meaningfulChildren = normalizedContent.filter(
      (child) => child.tag !== "#text" || Boolean(child.text?.trim())
    )
    if (tag === "ul" || tag === "ol") {
      if (meaningfulChildren.some((child) => child.tag !== "li"))
        fail(`${tag} accepts li children only.`, loc)
    }
    if (tag === "table") {
      if (
        meaningfulChildren.some(
          (child) => !["thead", "tbody", "tfoot", "tr"].includes(child.tag)
        )
      )
        fail("table accepts thead, tbody, tfoot or tr children only.", loc)
    }
    if (["thead", "tbody", "tfoot"].includes(tag)) {
      if (meaningfulChildren.some((child) => child.tag !== "tr"))
        fail(`${tag} accepts tr children only.`, loc)
    }
    if (tag === "tr") {
      if (meaningfulChildren.some((child) => !["th", "td"].includes(child.tag)))
        fail("tr accepts th or td children only.", loc)
    }
    if (n.type === "table") {
      const [header, ...rows] = content
      return [
        {
          tag,
          props,
          children: [
            {
              tag: "thead",
              props: {},
              children: header
                ? [
                    {
                      ...header,
                      children: header.children.map((cell) => ({
                        ...cell,
                        tag: "th",
                      })),
                    },
                  ]
                : [],
              ...loc,
            },
            { tag: "tbody", props: {}, children: rows, ...loc },
          ],
          ...loc,
        },
      ]
    }
    return [{ tag, props, children: normalizedContent, ...loc }]
  }
  const nodes = (ast.children ?? []).flatMap((n) => convert(n))
  const visit = (list: MdxNode[]) =>
    list.forEach((n) => {
      if (
        n.tag === "a" &&
        String(n.props.href).startsWith("#") &&
        !ids.has(String(n.props.href).slice(1))
      )
        fail(`Unknown document anchor: ${n.props.href}`, n)
      visit(n.children)
    })
  visit(nodes)
  return { version: 1, nodes }
}

/** Frontmatter and MDX are a single editable file; parsing never evaluates code. */
export function parseReportFile(file: string): ReportDocumentInput {
  function invalidFile(message: string): never {
    throw new Error(message)
  }
  if (file.length > 512000)
    invalidFile("Report file exceeds 512,000 characters.")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(file)
  if (!match)
    invalidFile(
      "Start the report with YAML frontmatter containing name, sources and bindings."
    )
  const yaml = parseDocument(match[1], { uniqueKeys: true })
  if (yaml.errors.length) invalidFile(yaml.errors[0].message)
  let data: unknown
  try {
    data = yaml.toJS({ maxAliasCount: 0 })
  } catch {
    invalidFile("YAML aliases are not supported.")
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    invalidFile("Frontmatter must be an object.")
  if (Object.hasOwn(data, "mdx"))
    invalidFile("Place MDX after the frontmatter.")
  return reportDocumentSchema.parse({
    ...data,
    mdx: file.slice(match[0].length),
  })
}
/** Convert body-relative compiler diagnostics to editor file line numbers. */
export function reportFileError(error: unknown, file: string) {
  const message =
    error instanceof Error ? error.message : "Unable to save report."
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(file)?.[0]
  const offset = header ? header.split("\n").length - 1 : 0
  return message.replace(
    /(^|\n)Line (\d+):(\d+):/g,
    (_, prefix, line, column) =>
      `${prefix}Line ${Number(line) + offset}:${column}:`
  )
}
export function serializeReportFile(input: ReportDocumentInput) {
  const { mdx, ...frontmatter } = input
  return `---\n${stringify(frontmatter, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n${mdx.trim()}\n`
}

export function compileReportDocument(document: ReportDocumentInput) {
  const compiled = parseReportMdx(document.mdx)
  const widgets: DashboardInput["widgets"] = []
  const references: z.infer<typeof reportReferenceSchema>[] = []
  const highlights: z.infer<typeof reportHighlightSchema>[] = []
  const sourceWidget = (name: string): DashboardWidget => {
    const source = document.sources[name]
    if (!source) fail(`Unknown source: ${name}`)
    return dashboardDataWidgetSchema.parse({
      id: `source-${name}`,
      title: name,
      type: "table",
      width: 3,
      query: source.query,
      presentation: source.presentation,
    })
  }
  for (const name of Object.keys(document.sources))
    widgets.push(sourceWidget(name))
  const used = new Set<string>()
  let componentCount = 0
  const visit = (nodes: MdxNode[]) =>
    nodes.forEach((node) => {
      const p = node.props
      if (
        [
          "Chart",
          "Matrix",
          "Table",
          "Metric",
          "Progression",
          "Comparison",
          "Scorecard",
        ].includes(node.tag) &&
        ++componentCount > 100
      )
        fail("Use at most 100 data components.", node)
      if (p.source) {
        if (!Object.hasOwn(document.sources, String(p.source)))
          fail(`Unknown source: ${p.source}`, node)
        used.add(String(p.source))
      }
      if (p.binding && !Object.hasOwn(document.bindings, String(p.binding)))
        fail(`Unknown evidence binding: ${p.binding}`, node)
      if (["Chart", "Matrix", "Table"].includes(node.tag)) {
        const base = sourceWidget(String(p.source))
        const widget = dashboardDataWidgetSchema.safeParse({
          ...base,
          id: `mdx-widget-${widgets.length}`,
          title: p.title ?? base.title,
          type: node.tag === "Chart" ? p.type : node.tag.toLowerCase(),
          series: p.series,
          presentation: p.presentation ?? base.presentation,
          trendDirection: p.trendDirection,
        })
        if (!widget.success)
          fail(widget.error.issues.map((i) => i.message).join("; "), node)
        node.widgetId = widget.data.id
        widgets.push(widget.data)
        for (const ref of (p.references as z.infer<
          typeof reportReferenceSchema
        >[]) ?? [])
          references.push({ ...ref, widgetId: widget.data.id })
        for (const h of (p.highlights as z.infer<
          typeof reportHighlightSchema
        >[]) ?? [])
          highlights.push({ ...h, widgetId: widget.data.id })
      }
      visit(node.children)
    })
  visit(compiled.nodes)
  const bindings: ReportBinding[] = Object.entries(document.bindings).map(
    ([key, b]) => {
      const convert = (s: z.infer<typeof selection>) => {
        sourceWidget(s.source)
        used.add(s.source)
        return {
          widgetId: `source-${s.source}`,
          measure: s.measure,
          dimensions: s.dimensions,
        }
      }
      return {
        ...b,
        id: key,
        textWidgetId: "mdx-evidence",
        source: convert(b.source),
        ...(b.baseline ? { baseline: convert(b.baseline) } : {}),
      } as ReportBinding
    }
  )
  if (bindings.length)
    widgets.push({
      id: "mdx-evidence",
      type: "text",
      title: "Evidence bindings",
      width: 3,
      content: bindings.map((b) => `{{evidence.${b.id}}}`).join(" "),
    })
  const warnings: ReportDiagnostic[] = Object.keys(document.sources)
    .filter((k) => !used.has(k))
    .map((k) => ({
      severity: "warning",
      message: `Source ${k} is captured but not used in the document.`,
      line: 1,
      column: 1,
    }))
  return {
    compiled,
    componentCount,
    config: {
      schemaVersion: 1 as const,
      name: document.name,
      description: document.description,
      widgets,
    },
    bindings,
    references,
    highlights,
    warnings,
  }
}
export function validateMdxEvidence(
  compiled: CompiledReportMdx,
  report: Pick<Report, "config" | "snapshot">
) {
  const visit = (nodes: MdxNode[]) =>
    nodes.forEach((node) => {
      const {
        source,
        className: _className,
        title: _title,
        description: _description,
        ...props
      } = node.props
      void _className
      void _title
      void _description
      try {
        const checkText = (value: unknown): void => {
          if (typeof value === "string") reportPresentationText(value, report)
          else if (Array.isArray(value)) value.forEach(checkText)
          else if (value && typeof value === "object")
            Object.values(value).forEach(checkText)
        }
        checkText(node.props)
        if (node.tag === "#text") checkText(node.text)
        const base = reportPresentationSchema.parse({
          schemaVersion: 1,
          eyebrow: "Report",
          title: "Report",
          summary: "Report",
          disclosure: "Captured evidence",
          metrics: [],
          sections: [
            { id: "evidence", title: "Evidence", description: "Evidence" },
          ],
        })
        if (node.tag === "Comparison" || node.tag === "Scorecard")
          base.comparison = reportComparisonSchema.parse({
            ...props,
            widgetId: `source-${source}`,
          })
        if (node.tag === "Progression")
          base.sections[0].progression =
            reportPresentationSchema.shape.sections.element.shape.progression.parse(
              { ...props, widgetId: `source-${source}` }
            )
        if (node.tag === "Metric" || node.tag === "Value")
          base.metrics = [
            {
              label: "Value",
              detail: "Evidence",
              tone: "neutral",
              evidenceId: String(props.binding),
            },
          ]
        validateReportPresentation(base, report)
      } catch (e) {
        fail(e instanceof Error ? e.message : "Invalid evidence.", node)
      }
      visit(node.children)
    })
  visit(compiled.nodes)
}

/** Start an MDX document from an existing dashboard or query template. */
export function dashboardReportDocument(
  config: DashboardInput
): ReportDocumentInput {
  const sources: ReportDocumentInput["sources"] = {}
  const bindings: ReportDocumentInput["bindings"] = {}
  const lines = [`# ${config.name}`, config.description]
  config.widgets.forEach((widget, index) => {
    if (widget.type === "text") {
      if (widget.content)
        lines.push(
          widget.content.replaceAll("<", "&lt;").replaceAll("{", "&#123;")
        )
      return
    }
    if (widget.groups?.length || widget.compare)
      throw new Error(
        "Choose explicit source queries for cohort comparisons in the MDX report."
      )
    const name = `data${index + 1}`
    sources[name] = { query: widget.query, presentation: widget.presentation }
    if (widget.type === "metric") {
      bindings[name] = {
        source: {
          source: name,
          measure: widget.query.measures[0],
          dimensions: {},
        },
        operation: "value",
      }
      lines.push(
        `<Metric binding="${name}" label={${JSON.stringify(widget.title)}} />`
      )
    } else {
      const tag =
        widget.type === "matrix"
          ? "Matrix"
          : widget.type === "table"
            ? "Table"
            : "Chart"
      lines.push(
        `<${tag} source="${name}"${tag === "Chart" ? ` type="${widget.type}"` : ""} title={${JSON.stringify(widget.title)}}${widget.series ? ` series={${JSON.stringify(widget.series)}}` : ""}${widget.trendDirection ? ` trendDirection="${widget.trendDirection}"` : ""} />`
      )
    }
  })
  return {
    name: config.name,
    description: config.description,
    mdx: lines.filter(Boolean).join("\n\n"),
    sources,
    bindings,
  }
}
