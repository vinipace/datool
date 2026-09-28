import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ReportMdxDocument } from "@/components/tracer/report-mdx-document"
import type { Report } from "@/src/lib/tracer/reports"
import type { CompiledReportMdx, MdxNode } from "@/src/lib/tracer/report-mdx"
import type { ReportRenderCheck } from "./report-render-validation"

async function readInput() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Report & {
    mdx: CompiledReportMdx
  }
}

function hasDisclosureNode(node: MdxNode): boolean {
  return node.tag === "Details" || node.children.some(hasDisclosureNode)
}

function expandDisclosureNodes(nodes: MdxNode[]): MdxNode[] {
  return nodes.flatMap((node) =>
    node.tag === "Details"
      ? expandDisclosureNodes(node.children)
      : [{ ...node, children: expandDisclosureNodes(node.children) }]
  )
}

function render(report: Report & { mdx: CompiledReportMdx }) {
  const markup = renderToStaticMarkup(
    createElement(ReportMdxDocument, { report })
  )
  const hasDisclosure = report.mdx.nodes.some(hasDisclosureNode)
  const expandedMarkup = hasDisclosure
    ? renderToStaticMarkup(
        createElement(ReportMdxDocument, {
          report: {
            ...report,
            mdx: {
              ...report.mdx,
              nodes: expandDisclosureNodes(report.mdx.nodes),
            },
          },
        })
      )
    : ""
  return {
    scope: "render" as const,
    status: "passed" as const,
    renderer: "react-dom/server" as const,
    markupBytes: Buffer.byteLength(markup) + Buffer.byteLength(expandedMarkup),
    nodeCount: report.mdx.nodes.length,
    expandedDisclosureCheck: hasDisclosure,
    visualReviewRequired: true as const,
    responsiveReviewRequired: true as const,
  } satisfies ReportRenderCheck
}

try {
  process.stdout.write(JSON.stringify(render(await readInput())))
} catch (error) {
  const result: ReportRenderCheck = {
    scope: "render",
    status: "failed",
    renderer: "react-dom/server",
    message: error instanceof Error ? error.message : "Unknown renderer error.",
    visualReviewRequired: true,
    responsiveReviewRequired: true,
  }
  process.stdout.write(JSON.stringify(result))
}
