import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"
import {
  reportDocumentSchema,
  parseReportMdx,
  parseReportFile,
  serializeReportFile,
  compileReportDocument,
  reportComponentsCatalog,
  reportFileError,
} from "../src/lib/tracer/report-mdx"
import { createReportService } from "../src/server/tracer/reports"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"

const doc = (mdx: string) =>
  reportDocumentSchema.parse({ name: "MDX study", mdx })
test("MDX syntax is data, never executable JavaScript", () => {
  for (const mdx of [
    'import X from "evil"',
    "export const x=1",
    "{process.env.SECRET}",
    "<div {...props} />",
    '<div onClick="alert(1)" />',
    "<script>alert(1)</script>",
    '<iframe src="https://example.com" />',
    '<div style={{"color":"red"}} />',
    '<div className="bg-red-500" />',
    '<a href="javascript:alert(1)">x</a>',
    "[bad](javascript:alert%281%29)",
    "<Metrics columns={1+1} />",
    "<Unknown />",
    '<Value binding="x">Child</Value>',
    '<div id="duplicate" /><div id="duplicate" />',
    "[Missing](#absent)",
    'Inline <Table source="quality" /> text.',
    "<p><div>Invalid nesting</div></p>",
  ])
    expect(() => parseReportMdx(mdx)).toThrow()
  expect(
    parseReportMdx(
      '<div className="grid gap-6 md:grid-cols-2">\n\n## Heading\n\n**Bold** and `code`.\n\n</div>'
    ).nodes[0].tag
  ).toBe("div")
  expect(() => parseReportMdx("<Metrics columns={9} />")).toThrow("Metrics")
  expect(reportComponentsCatalog().components.map((c) => c.name)).toContain(
    "Scorecard"
  )
  const table = parseReportMdx("| Stage | Score |\n| --- | --- |\n| v4 | 95% |")
    .nodes[0]
  expect(table.children.map((node) => node.tag)).toEqual(["thead", "tbody"])
  expect(table.children[0].children[0].children[0].tag).toBe("th")
  expect(
    parseReportMdx('Precision is <Value binding="precision" />.').nodes[0]
      .children[1].tag
  ).toBe("Value")
})
test("ordinary supported JSX markup composes with Markdown and inline evidence", () => {
  const parsed = parseReportMdx(`
<h1 className="text-4xl font-bold">Evaluation results</h1>

<p className="text-lg leading-relaxed">
  Precision is <strong>reliable</strong> and <em><Value binding="precision" /></em>.
</p>

## Method

<p>Use the <strong>same captured tickets</strong> for every candidate.<br />Keep the comparison paired.</p>
`)

  expect(parsed.nodes.map((node) => node.tag)).toEqual(["h1", "p", "h2", "p"])
  expect(parsed.nodes[0].props).toEqual({
    className: "text-4xl font-bold",
  })
  expect(parsed.nodes[1].children.map((node) => node.tag)).toEqual([
    "#text",
    "strong",
    "#text",
    "em",
    "#text",
  ])
  expect(parsed.nodes[1].children[3].children[0].tag).toBe("Value")
  expect(parsed.nodes[3].children.at(-1)?.tag).toBe("#text")
  expect(parsed.nodes[3].children.at(-2)?.tag).toBe("br")

  const list = parseReportMdx(
    "<ul>\n<li><strong>One</strong></li>\n<li>Two</li>\n</ul>"
  ).nodes[0]
  expect(list.tag).toBe("ul")
  expect(list.children.filter((node) => node.tag === "li")).toHaveLength(2)

  expect(() => parseReportMdx("<ul><p>Invalid list child</p></ul>"))
    .toThrow("li children only")
  expect(() => parseReportMdx("<p><div>Invalid nesting</div></p>"))
    .toThrow("inline content only")
  expect(() => parseReportMdx("<p><p>Invalid nested paragraph</p></p>"))
    .toThrow("inline content only")
  expect(() => parseReportMdx("<span><p>Invalid block child</p></span>"))
    .toThrow("inline content only")
  expect(() =>
    parseReportMdx(
      '<a href="https://example.com"><strong><a href="https://example.org">Invalid nested link</a></strong></a>'
    )
  ).toThrow("Links cannot contain other links")
  expect(() => parseReportMdx("<p><br>Invalid child</br></p>"))
    .toThrow("void element")
  expect(parseReportMdx("<p>Before<br />After</p>").nodes[0].children.map((node) => node.tag)).toEqual([
    "#text",
    "br",
    "#text",
  ])
})
test("frontmatter round trips and rejects duplicate keys and aliases", () => {
  const document = doc("# Notes\n\nA readable report.")
  expect(parseReportFile(serializeReportFile(document))).toEqual({
    ...document,
    mdx: "\n" + document.mdx + "\n",
  })
  expect(() => parseReportFile("---\nname: A\nname: B\n---\n# Test")).toThrow()
  expect(() =>
    parseReportFile("---\nname: &a Test\ndescription: *a\n---\n# Test")
  ).toThrow("aliases")
  expect(() =>
    parseReportFile("---\nname: Test\nmdx: surprise\n---\n# Test")
  ).toThrow("after the frontmatter")
  expect(() =>
    compileReportDocument(doc('<Table source="missing" />'))
  ).toThrow("Unknown source")
  expect(() =>
    compileReportDocument(doc('<Value binding="missing" />'))
  ).toThrow("Unknown evidence binding")
  const limited = reportDocumentSchema.parse({
    name: "Limit",
    sources: {
      quality: {
        query: {
          measures: ["evalResults.meanScore"],
          timeDimensions: [
            {
              dimension: "evalResults.completedAt",
              dateRange: ["2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"],
            },
          ],
        },
      },
    },
    mdx: Array(100).fill('<Table source="quality" />').join("\n\n"),
  })
  expect(compileReportDocument(limited).componentCount).toBe(100)
  expect(() =>
    compileReportDocument({
      ...limited,
      mdx: limited.mdx + '\n\n<Table source="quality" />',
    })
  ).toThrow("at most 100")
  const file = "---\nname: Study\n---\n\n# Study\n\n<Unknown />"
  try {
    compileReportDocument(parseReportFile(file))
    throw new Error("Expected invalid MDX")
  } catch (error) {
    expect(reportFileError(error, file)).toContain("Line 7:1:")
  }
})
test("MDX validates real evidence, deduplicates queries, edits frozen data and requires explicit refresh", async () => {
  const db = await createTracerFixture()
  try {
    await seedEvalAttributionFacts(db, 2, 5)
    const service = createReportService(db)
    const document = reportDocumentSchema.parse({
      name: "Evidence story",
      mdx: '<Metric binding="score" label="Recorded mean" />\n\n<Chart source="quality" type="bar" />\n\n<Table source="quality" />',
      sources: {
        quality: {
          query: {
            measures: ["evalResults.meanScore"],
            dimensions: ["evalResults.runId"],
            timeDimensions: [
              {
                dimension: "evalResults.completedAt",
                dateRange: [
                  new Date(Date.now() - 86400000).toISOString(),
                  new Date(Date.now() + 1000).toISOString(),
                ],
              },
            ],
          },
        },
      },
      bindings: {
        score: {
          source: {
            source: "quality",
            measure: "evalResults.meanScore",
            dimensions: { "evalResults.runId": "run-2" },
          },
          operation: "value",
          format: "percent",
          decimals: 1,
        },
      },
    })
    expect((await run(service.validate({ document }))).valid).toBe(true)
    expect(await run(service.list())).toEqual([])
    const report = await run(
      service.create({ ...document, creationKey: crypto.randomUUID() })
    )
    expect(report.mdx?.nodes.map((n) => n.tag)).toEqual([
      "Metric",
      "Chart",
      "Table",
    ])
    expect(report.snapshot.results).toHaveLength(1)
    expect(report.widgetCount).toBe(3)
    const expected = structuredClone(report.snapshot.results)
    await db.execute(sql`update scores set value=0.99`)
    const edited = await run(
      service.update({
        number: report.number,
        revision: 1,
        document: { ...document, mdx: "# Revised findings\n\n" + document.mdx },
      })
    )
    expect(edited.snapshot.results).toEqual(expected)
    expect(edited.frozenAt).toBe(report.frozenAt)
    const badAnnotation = {
      ...document,
      mdx: '<Chart source="quality" type="bar" highlights={[{"dimensions":{"evalResults.runId":"absent"},"label":"Missing"}]} />',
    }
    await rejects(
      run(
        service.update({
          number: report.number,
          revision: 2,
          document: badAnnotation,
        })
      ),
      /does not match/
    )
    const queryChange = structuredClone(document)
    queryChange.sources.quality.query.filters = [
      { member: "evalResults.runId", operator: "equals", values: ["run-2"] },
    ]
    await rejects(
      run(
        service.update({
          number: report.number,
          revision: 2,
          document: queryChange,
        })
      ),
      /Refresh/
    )
    expect((await run(service.get(report.number))).revision).toBe(2)
    const refreshed = await run(
      service.update({
        number: report.number,
        revision: 2,
        document: queryChange,
        refresh: true,
      })
    )
    expect(
      Math.abs(
        Number(refreshed.snapshot.results[0].data[0]["evalResults.meanScore"]) -
          0.99
      ) < 1e-9
    ).toBe(true)
    const invalid = await run(
      service.validate({
        document: { ...document, mdx: "# Start\n\n<Unknown />" },
      })
    )
    expect(invalid).toMatchObject({
      valid: false,
      diagnostics: [{ line: 3, severity: "error" }],
    })
    const inaccurate = structuredClone(document)
    inaccurate.bindings.score.expected = 0.2
    expect((await run(service.validate({ document: inaccurate }))).valid).toBe(
      false
    )
  } finally {
    await closeTracerFixture(db)
  }
}, 30000)
