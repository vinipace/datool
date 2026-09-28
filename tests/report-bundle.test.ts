import { expect, test } from "bun:test"
import {
  parseReportBundle,
  reportBundleError,
  ReportBundleError,
  serializeReportBundle,
} from "../src/lib/tracer/report-bundle"
import {
  compileReportDocument,
  reportDocumentSchema,
} from "../src/lib/tracer/report-mdx"
import { reportAuthoringGuide } from "../src/lib/tracer/report-authoring-guide"

test("paired report files round trip without changing the stored document shape", () => {
  const document = reportDocumentSchema.parse({
    name: "Coverage study",
    description: "A compact evaluation report.",
    mdx: '# Findings\n\n<Chart source="quality" type="line" />',
    sources: {},
    bindings: {},
  })
  const bundle = serializeReportBundle(document)

  expect(bundle.mdx).toBe(`${document.mdx}\n`)
  expect(JSON.parse(bundle.data)).toEqual({
    name: document.name,
    description: document.description,
    sources: document.sources,
    bindings: document.bindings,
  })
  expect(parseReportBundle(bundle.mdx, bundle.data)).toEqual({
    ...document,
    mdx: bundle.mdx,
  })
})

test("the discovered recipe is a valid two-file starting point", () => {
  const guide = reportAuthoringGuide()
  const document = parseReportBundle(
    guide.recipe.files["report.mdx"],
    guide.recipe.files["report.data.json"]
  )
  expect(compileReportDocument(document).compiled.nodes[0].tag).toBe("ReportHeader")
  expect(guide.componentCatalog.htmlTags).toContain("h1")
})

test("paired parsing keeps legacy one-file reports working", () => {
  const file = "---\nname: Legacy\nsources: {}\nbindings: {}\n---\n# Notes\n"
  expect(parseReportBundle(file)).toEqual({
    name: "Legacy",
    description: "",
    sources: {},
    bindings: {},
    mdx: "# Notes\n",
  })
  expect(() =>
    parseReportBundle(
      "---\nname: Legacy\n---\n# Notes\n",
      JSON.stringify({ name: "Paired", sources: {}, bindings: {} })
    )
  ).toThrow("Paired report.mdx")
})

test("data diagnostics point at the data file and JSON position", () => {
  try {
    parseReportBundle("# Findings\n", '{\n  "name": "Study",\n')
    throw new Error("Expected invalid JSON")
  } catch (error) {
    expect(error).toBeInstanceOf(ReportBundleError)
    expect((error as ReportBundleError).source).toBe("data")
    expect(
      reportBundleError(error, "data", '{\n  "name": "Study",\n')
    ).toContain("Line 3:")
  }
})

test("paired narrative accepts Markdown dividers and locates body errors", () => {
  const data = JSON.stringify({ name: "Study" })
  const mdx = "---\n\nOpening note.\n\n---\n\n# Findings\n"
  expect(parseReportBundle(mdx, data).mdx).toBe(mdx)
  const invalid = mdx + "\n<Unknown />"
  try {
    compileReportDocument(parseReportBundle(invalid, data))
    throw new Error("Expected unknown component to fail")
  } catch (error) {
    expect(reportBundleError(error, "mdx", invalid)).toContain("Line 9:1:")
  }
  try {
    parseReportBundle("", data)
    throw new Error("Expected empty MDX to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(ReportBundleError)
    expect((error as ReportBundleError).source).toBe("mdx")
  }
})
