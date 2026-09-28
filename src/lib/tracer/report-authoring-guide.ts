import { evaluationStoryRecipe } from "./report-recipe"
import { reportComponentsCatalog } from "./report-mdx"

/**
 * The compact, agent-facing entry point for the report authoring contract.
 *
 * Keep this response declarative: it is used by MCP, the CLI and REST
 * discovery, so an agent can learn the workflow without scraping prose docs.
 * The component catalog and recipe remain the canonical sources for prop
 * schemas and the starter document; this guide simply puts them in the order
 * an author needs them.
 */
export function reportAuthoringGuide() {
  return {
    version: 1,
    id: "mdx-report-authoring",
    name: "MDX report authoring",
    format: "mdx",
    purpose:
      "Compose a private, evidence-bound report draft from Markdown, registered components and named semantic queries.",
    contract: {
      document:
        "{ name, description, mdx, sources, bindings } plus creationKey only for create_report.",
      files: {
        mdx: "report.mdx contains narrative, supported HTML and registered components, without frontmatter.",
        data: "report.data.json contains { name, description, sources, bindings }. The CLI loads the same-stem sibling automatically, or accepts --data-file <path>.",
        storage: "Both files produce the same document payload; queries and evidence remain captured together. The UI edits MDX and Data in separate tabs and saves them together.",
      },
      sources:
        "Named semantic queries. Components reference a source name; identical queries are captured once in the frozen snapshot.",
      bindings:
        "Named evidence selectors and calculations used by Value and Metric. Expected values catch stale or unsupported claims.",
      safety:
        "The server parses and validates MDX; authored JavaScript, imports, event handlers, arbitrary styles and remote embeds are not evaluated.",
      lifecycle:
        "validate_report is read-only, create_report saves a private draft, update_report edits a draft with revision checks, publish_report locks the reviewed revision, and set_report_sharing is a separate explicit action.",
    },
    workflow: [
      {
        step: 1,
        name: "Discover",
        call: "get_report_authoring_guide",
        result:
          "This contract, component examples, limits, validation scope and the recommended next calls.",
      },
      {
        step: 2,
        name: "Inspect data",
        calls: ["get_metrics_metadata", "query_metrics", "batch_metrics"],
        result:
          "A bounded population with pinned versions, units, denominators, missing values and date window understood before writing claims.",
      },
      {
        step: 3,
        name: "Choose composition",
        calls: ["get_report_components", "get_report_recipe", "get_report_template"],
        result:
          "A starter document and the exact registered component props. Adapt the order to the reader's decision; the recipe is guidance, not a fixed layout.",
      },
      {
        step: 4,
        name: "Validate",
        call: "validate_report",
        result:
          "Structural MDX, source and binding checks, captured data shape checks, and a server-render smoke check. This call saves nothing and consumes no report number.",
      },
      {
        step: 5,
        name: "Save a draft",
        call: "create_report",
        result:
          "A private frozen draft. Use one stable UUID creationKey and retry the same payload if delivery is uncertain.",
      },
      {
        step: 6,
        name: "Review and refine",
        calls: ["get_report", "resolve_report", "update_report"],
        result:
          "Read the current revision, resolve its project-local URL, inspect the rendered draft at desktop (at least 1024px) and mobile (around 390px), then update with the current revision. Query changes require refresh:true.",
      },
      {
        step: 7,
        name: "Publish or share",
        calls: ["publish_report", "set_report_sharing"],
        result:
          "Only after review: publish the exact revision, then enable a public URL separately when authorized.",
      },
    ],
    componentExamples: [
      {
        name: "Evidence-bound opening",
        mdx: '<ReportHeader eyebrow="Evaluation study" title="The result and its limitation" summary="Lead with the decision, population and remaining risk." />',
      },
      {
        name: "Bound metric",
        mdx: '<Metrics columns={2}>\n  <Metric binding="precision" label="Precision" tone="positive" />\n  <Metric binding="missed" label="Missed escalations" tone="warning" />\n</Metrics>',
      },
      {
        name: "Shared chart",
        mdx: '<Chart source="quality" type="line" title="Quality across stages" trendDirection="increase" height="medium" />',
      },
      {
        name: "Comparison and detail",
        mdx: '<Comparison source="quality" dimension="evalResults.groupVersion" baseline="v1" candidate="v4" candidates={[{"value":"v1","label":"Baseline"},{"value":"v4","label":"Candidate"}]} metrics={[{"member":"evalResults.meanScore","label":"Mean score","direction":"higher"}]} />\n\n<Details id="methodology" title="Methodology">\nExplain denominators and exclusions here.\n</Details>',
      },
      {
        name: "Inline claim",
        mdx: 'The candidate reaches <Value binding="precision" /> on the captured population.',
      },
    ],
    limits: {
      namedSources: 20,
      bindings: 100,
      dataComponents: 100,
      expandedQueries: 40,
      rowsPerQuery: 5000,
      savedContentBytes: 8 * 1024 * 1024,
    },
    validationScope: {
      structural: "MDX syntax, allowlisted elements, component props, source names, binding references, IDs and static classes.",
      data: "Semantic query capture, complete frozen rows, units, dimensions, selectors, calculations, highlights and expected values.",
      render: "The shared React renderer is invoked server-side and must produce static markup without throwing. This catches runtime renderer failures before a draft is saved.",
      visual: "Not proven by this API: browser layout, typography, color balance, accessibility interaction, mobile overflow and chart readability still require rendered desktop/mobile review.",
      responsive: "Not proven by this API: review the resolved draft at a wide desktop viewport and around 390px mobile width for wrapping, overflow, disclosure focus and readable chart/table content.",
    },
    nextSteps: {
      firstCall: "get_metrics_metadata",
      ifYouHaveAStarter: "get_report_template",
      beforeSaving: "validate_report",
      afterSaving: "get_report",
      whenEditing: "update_report",
      beforeExternalAccess: "publish_report then set_report_sharing",
    },
    preview: {
      runtime: "validate_report invokes the shared renderer server-side and reports structural/data/render status before saving.",
      url: "After create_report, call resolve_report({key: String(number)}) with the returned report number, open its URL, and inspect the private draft at desktop and mobile widths.",
      desktop: "Review at a wide viewport (at least 1024px): hierarchy, chart labels, comparison columns and disclosure affordances.",
      mobile: "Review around 390px: horizontal table/chart overflow, wrapped headings, disclosure focus and readable numeric values.",
      notProvenByApi: "Markup generation does not prove colors, spacing, typography, accessibility interaction or responsive layout. The API marks visual and responsive checks as not-run.",
      evidence: "Save desktop and mobile screenshots after reviewing the private draft. Expand disclosures and check the full captured evidence before publication.",
    },
    cli: [
      "datool reports guide",
      "datool reports validate --file report.mdx",
      "datool reports create --file report.mdx --creation-key <uuid>",
      "datool reports resolve <number>",
      "datool reports validate <number> --revision <revision> --file report.mdx",
      "datool reports update <number> --revision <revision> --file report.mdx",
    ],
    recipe: evaluationStoryRecipe,
    componentCatalog: reportComponentsCatalog(),
  } as const
}
