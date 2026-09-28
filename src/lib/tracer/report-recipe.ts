import type { Report } from "./reports"
import type { ReportBlock, ReportPresentation } from "./report-presentation"
import { defaultReportComparison } from "./report-layouts"

const starterMdx = `<ReportHeader eyebrow="Evaluation study" title="The main finding" summary="State the answer, scope and remaining limitation." />

## Evidence

Add named sources, then use the component catalog to compose charts and comparisons.

<Details id="methodology" title="Scope and methodology">

Describe denominators, versions, missing observations and limitations.

</Details>

## Next step

State the evidence-supported action.
`

/** Agent-discoverable authoring guidance. Drafts are reviewed before explicit publication. */
export const evaluationStoryRecipe = {
  id: "evaluation-story",
  name: "Evaluation story",
  format: "mdx",
  description:
    "A concise opening, evidence-bound metrics, progression, candidate comparison, expandable supporting evidence and a closing scorecard. Adapt the composition to the question.",
  workflow: [
    "Discover metrics and query the bounded population. Pin scorer and candidate versions; inspect coverage and denominators.",
    "Start with get_report_authoring_guide for component props and supported Tailwind utilities. Write narrative and layout in report.mdx, and name, description, sources and bindings in report.data.json. Component props use JSON literals only.",
    "Use ReportHeader and Metrics for the answer, Progression for change, Comparison for baseline differences, Details for supporting evidence, and Scorecard for a closing decision. These are optional components, not fixed layouts.",
    "Use Value bindings for numeric claims and expected values to catch stale claims. Declare higher/lower metric directions. Only set targets supported by user requirements. Keep synthetic data, denominators and missing observations explicit.",
    "Reuse named query sources across components. Avoid repeating the same chart or matrix in multiple sections. Use responsive grids and the shared semantic palette.",
    "Call validate_report with document, then create_report with a stable UUID creationKey. Read get_report and inspect the actual rendered draft at desktop and mobile widths. Valid props alone do not prove good visual quality.",
    "Edit MDX via update_report with number, revision and document. Captured evidence is preserved unless refresh:true. Changed queries require explicit refresh and another review.",
    "Publish only the approved revision with publish_report. Enable set_report_sharing separately when authorized. Published reports are immutable; clone_report starts a new private draft.",
  ],
  files: {
    "report.mdx": starterMdx,
    "report.data.json": JSON.stringify({
      name: "Evaluation report",
      description: "Question, population and decision",
      sources: {},
      bindings: {},
    }, null, 2) + "\n",
  },
} as const

type Section = ReportPresentation["sections"][number]
type Widget = Section["widgets"][number]
export type PlannedReportBlock =
  | { type: "brief"; section?: Section; widget?: Widget }
  | Extract<ReportBlock, { type: "comparison" | "scorecard" }>
  | { type: "section"; section: Section }
  | { type: "evidence"; title: string; sections: Section[] }

/** One deterministic plan, independent of which disclosures the reader has opened. */
export function composeReport(
  report: Pick<Report, "config" | "snapshot">,
  presentation: ReportPresentation
) {
  const comparison =
    presentation.comparison ??
    (!presentation.recipe && !presentation.blocks
      ? defaultReportComparison(report)
      : undefined)
  const primary = presentation.sections.find((section) => section.progression)
  const blocks: ReportBlock[] = presentation.blocks ?? [
    { type: "brief", ...(primary ? { sectionId: primary.id } : {}) },
    ...(comparison ? [{ type: "comparison" } as const] : []),
    {
      type: "evidence",
      title: "Explore the evidence",
      sectionIds: presentation.sections.map((section) => section.id),
    },
    ...(comparison
      ? [{ type: "scorecard", title: "Final candidate" } as const]
      : []),
  ]
  const used = new Set<string>()
  // Composite visualizations replace their raw source widget, not each other.
  if (
    blocks.some(
      (block) => block.type === "comparison" || block.type === "scorecard"
    ) &&
    comparison
  )
    used.add(comparison.widgetId)
  const takeWidgets = (widgets: Widget[]) =>
    widgets.filter((widget) => {
      if (used.has(widget.widgetId)) return false
      used.add(widget.widgetId)
      return true
    })
  const sections = new Map(
    presentation.sections.map((section) => [section.id, section])
  )
  const consumeSection = (section: Section): Section | undefined => {
    const progression =
      section.progression && !used.has(section.progression.widgetId)
        ? section.progression
        : undefined
    if (progression) used.add(progression.widgetId)
    const widgets = takeWidgets(section.widgets)
    const details = section.details
      .map((detail) => ({ ...detail, widgets: takeWidgets(detail.widgets) }))
      .filter((detail) => detail.widgets.length)
    if (!progression && !widgets.length && !details.length) return undefined
    return { ...section, progression, widgets, details }
  }
  const plan: PlannedReportBlock[] = []
  for (const block of blocks) {
    if (block.type === "brief") {
      const section = block.sectionId ? sections.get(block.sectionId) : primary
      if (section?.progression) {
        used.add(section.progression.widgetId)
        plan.push({ type: "brief", section })
      } else {
        const widget = presentation.sections
          .flatMap((s) => s.widgets)
          .find(
            (w) =>
              !used.has(w.widgetId) &&
              report.config.widgets.find((item) => item.id === w.widgetId)
                ?.type !== "text"
          )
        if (widget) used.add(widget.widgetId)
        plan.push({ type: "brief", widget })
      }
    } else if (block.type === "section") {
      const section = consumeSection(sections.get(block.sectionId)!)
      if (section) plan.push({ type: "section", section })
    } else if (block.type === "evidence") {
      const content = block.sectionIds
        .map((id) => consumeSection(sections.get(id)!))
        .filter((section): section is Section => !!section)
      if (content.length)
        plan.push({ type: "evidence", title: block.title, sections: content })
    } else if (comparison) plan.push(block)
  }
  return { comparison, blocks: plan }
}
