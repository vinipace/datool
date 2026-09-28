import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ReportMdxDocument } from "@/components/tracer/report-mdx-document"
import {
  compileReportDocument,
  reportDocumentSchema,
} from "@/src/lib/tracer/report-mdx"
import type { Report } from "@/src/lib/tracer/reports"
import { renderReportForValidation } from "@/src/server/tracer/report-render-validation"

test("validated MDX renders line breaks and dividers without void-element errors", () => {
  const document = reportDocumentSchema.parse({
    name: "Decision memo",
    mdx: "# Advance v4.<br />Test the blind spot.\n\n---\n\nKeep the evidence visible.\n\n<hr />",
  })
  const { compiled, config } = compileReportDocument(document)
  const report: Report = {
    id: "render-test",
    number: 1,
    name: document.name,
    description: "",
    templateId: "custom",
    widgetCount: 0,
    createdAt: "2026-09-27T00:00:00Z",
    frozenAt: "2026-09-27T00:00:00Z",
    document,
    mdx: compiled,
    config,
    snapshot: { schemaVersion: 1, positions: [], results: [] },
  }
  const html = renderToStaticMarkup(<ReportMdxDocument report={report} />)
  expect(/Advance v4\.<br\b[^>]*\/>Test the blind spot\./.test(html)).toBe(true)
  expect(html.match(/<hr\b/g)).toHaveLength(2)
  expect(html).toContain("Keep the evidence visible.")
})

test("SSR renders ordinary JSX block markup and nested inline evidence", () => {
  const document = reportDocumentSchema.parse({
    name: "Markup memo",
    sources: {
      quality: {
        query: {
          measures: ["evalResults.meanScore"],
          dimensions: ["evalResults.runId"],
          timeDimensions: [
            {
              dimension: "evalResults.completedAt",
              dateRange: ["2026-09-26T00:00:00Z", "2026-09-27T00:00:00Z"],
            },
          ],
        },
      },
    },
    bindings: {
      precision: {
        source: {
          source: "quality",
          measure: "evalResults.meanScore",
          dimensions: { "evalResults.runId": "run-1" },
        },
        operation: "value",
        format: "percent",
        decimals: 1,
      },
    },
    mdx: `
<h1 className="text-4xl font-bold">Evaluation results</h1>

<p className="text-lg leading-relaxed">Precision is <strong>reliable</strong> and <em><Value binding="precision" /></em>.</p>
`,
  })
  const { compiled, config } = compileReportDocument(document)
  const report: Report = {
    id: "render-markup",
    number: 1,
    name: document.name,
    description: "",
    templateId: "custom",
    widgetCount: 0,
    createdAt: "2026-09-27T00:00:00Z",
    frozenAt: "2026-09-27T00:00:00Z",
    document,
    mdx: compiled,
    config,
    snapshot: {
      schemaVersion: 1,
      positions: [],
      results: [],
      evidence: {
        templates: {},
        values: [
          {
            binding: {
              id: "precision",
              textWidgetId: "mdx-evidence",
              source: {
                widgetId: "source-quality",
                measure: "evalResults.meanScore",
                dimensions: {},
              },
              operation: "value",
            },
            sourceValue: 0.95,
            value: 0.95,
            formatted: "95.0%",
          },
        ],
      },
    },
  }
  const html = renderToStaticMarkup(<ReportMdxDocument report={report} />)
  expect(
    /<h1 class="[^"]*text-4xl font-bold">Evaluation results<\/h1>/.test(html)
  ).toBe(true)
  expect(html).toContain("<strong class=\"font-semibold\">reliable</strong>")
  expect(html).toContain(
    "<em class=\"\"><span class=\"font-mono tabular-nums\">95.0%</span></em>"
  )
})

test("render validation reports shared renderer failures separately from MDX parsing", async () => {
  const report: Report = {
    id: "render-failure",
    number: 1,
    name: "Broken render",
    description: "",
    templateId: "custom",
    widgetCount: 0,
    createdAt: "2026-09-27T00:00:00Z",
    frozenAt: "2026-09-27T00:00:00Z",
    config: { schemaVersion: 1, name: "Broken render", description: "", widgets: [] },
    snapshot: { schemaVersion: 1, positions: [], results: [] },
    mdx: {
      version: 1,
      nodes: [{ tag: "Comparison", props: {}, children: [], line: 1, column: 1 }],
    },
  }
  expect(await renderReportForValidation(report as Report & { mdx: NonNullable<Report["mdx"]> })).toMatchObject({
    scope: "render",
    status: "failed",
    renderer: "react-dom/server",
    visualReviewRequired: true,
    responsiveReviewRequired: true,
  })
})

test("render validation exercises components inside closed Details disclosures", async () => {
  const report = {
    id: "render-disclosure-failure",
    number: 1,
    name: "Broken disclosure",
    description: "",
    templateId: "custom",
    widgetCount: 0,
    createdAt: "2026-09-27T00:00:00Z",
    frozenAt: "2026-09-27T00:00:00Z",
    config: { schemaVersion: 1, name: "Broken disclosure", description: "", widgets: [] },
    snapshot: { schemaVersion: 1 as const, positions: [], results: [] },
    mdx: {
      version: 1 as const,
      nodes: [
        {
          tag: "Details",
          props: { id: "evidence", title: "Evidence" },
          children: [{ tag: "Comparison", props: {}, children: [], line: 2, column: 1 }],
          line: 1,
          column: 1,
        },
      ],
    },
  }
  expect(await renderReportForValidation(report as Report & { mdx: NonNullable<Report["mdx"]> })).toMatchObject({
    status: "failed",
    renderer: "react-dom/server",
  })
})
