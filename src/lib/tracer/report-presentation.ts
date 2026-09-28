import { z } from "zod"
import type { Report } from "./reports"
import {
  reportComparisonSchema,
  reportLayoutSchema,
} from "./report-layout-contract"

const text = z.string().min(1).max(4000)
const sectionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const reportBlockSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("brief"), sectionId: sectionId.optional() })
    .strict(),
  z
    .object({
      type: z.literal("comparison"),
      title: text.optional(),
      description: text.optional(),
    })
    .strict(),
  z.object({ type: z.literal("section"), sectionId }).strict(),
  z
    .object({
      type: z.literal("evidence"),
      title: text,
      sectionIds: z.array(sectionId).min(1).max(10),
    })
    .strict(),
  z
    .object({
      type: z.literal("scorecard"),
      title: text.optional(),
      description: text.optional(),
    })
    .strict(),
])
export type ReportBlock = z.infer<typeof reportBlockSchema>
const widget = z
  .object({
    widgetId: z.string().min(1).max(100),
    title: text.optional(),
    caption: text.optional(),
    width: z.enum(["full", "half"]).default("full"),
  })
  .strict()

/** Reading composition only. All values and charts resolve against frozen evidence. */
export const reportPresentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    eyebrow: text,
    title: text,
    summary: text,
    disclosure: text,
    recipe: z.literal("evaluation-story").optional(),
    blocks: z.array(reportBlockSchema).min(1).max(20).optional(),
    comparison: reportComparisonSchema.optional(),
    metrics: z
      .array(
        z
          .object({
            label: text,
            evidenceId: z.string().min(1).max(64),
            detail: text,
            tone: z.enum(["neutral", "positive", "warning"]).default("neutral"),
          })
          .strict()
      )
      .max(4),
    sections: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            title: text,
            navLabel: text.optional(),
            description: text,
            takeaway: text.optional(),
            progression: z
              .object({
                widgetId: z.string().min(1).max(100),
                dimension: z.string().min(1),
                measures: z
                  .array(
                    z
                      .object({ member: z.string().min(1), label: text })
                      .strict()
                  )
                  .min(1)
                  .max(2),
                stages: z
                  .array(
                    z
                      .object({
                        value: z.string(),
                        label: text,
                        title: text,
                        description: text,
                      })
                      .strict()
                  )
                  .min(2)
                  .max(8),
              })
              .strict()
              .optional(),
            widgets: z.array(widget).max(20).default([]),
            details: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
                    title: text,
                    description: text,
                    widgets: z.array(widget).min(1).max(20),
                  })
                  .strict()
              )
              .max(5)
              .default([]),
          })
          .strict()
      )
      .min(1)
      .max(10),
  })
  .strict()
export type ReportPresentation = z.infer<typeof reportPresentationSchema>
export const reportPresentationInputSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().min(0),
    presentation: reportPresentationSchema.nullable().optional(),
    layout: reportLayoutSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.presentation !== undefined || value.layout !== undefined,
    "Choose a layout or supply a presentation."
  )

export function reportPresentationText(
  text: string,
  report: Pick<Report, "snapshot">
) {
  return text.replace(/\{\{evidence\.([^}]+)\}\}/g, (_, id: string) => {
    const evidence = report.snapshot.evidence?.values.find(
      (v) => v.binding.id === id
    )
    if (!evidence) throw new Error(`Unknown frozen evidence: ${id}`)
    return evidence.formatted
  })
}

export function reportPresentationResult(
  report: Pick<Report, "snapshot">,
  widgetId: string
) {
  const position = report.snapshot.positions.find((p) => p.id === widgetId)
  if (!position || position.cohorts.length !== 1)
    throw new Error(
      "Presentation requires one captured cohort for this widget."
    )
  return report.snapshot.results[position.cohorts[0].result]
}

export function validateReportPresentation(
  presentation: ReportPresentation,
  report: Pick<Report, "config" | "snapshot">
) {
  const widgets = new Map(report.config.widgets.map((w) => [w.id, w]))
  const ids = new Set<string>()
  const unique = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate presentation section: ${id}`)
    ids.add(id)
  }
  const checkWidget = (id: string) => {
    if (!widgets.has(id)) throw new Error(`Unknown captured widget: ${id}`)
  }
  const checkText = (value: unknown): void => {
    if (typeof value === "string") reportPresentationText(value, report)
    else if (Array.isArray(value)) value.forEach(checkText)
    else if (value && typeof value === "object")
      Object.values(value).forEach(checkText)
  }
  checkText(presentation)
  const comparison = presentation.comparison
  const sectionIds = new Set(presentation.sections.map((section) => section.id))
  const placed = new Set<string>()
  const singletons = new Set<string>()
  for (const [index, block] of (presentation.blocks ?? []).entries()) {
    if (block.type === "brief" && index !== 0)
      throw new Error("The brief must open the report.")
    if (block.type === "scorecard" && index !== presentation.blocks!.length - 1)
      throw new Error("The scorecard must close the report.")
    if (["brief", "comparison", "scorecard"].includes(block.type)) {
      if (singletons.has(block.type))
        throw new Error(`Duplicate report block: ${block.type}`)
      singletons.add(block.type)
    }
    if (
      (block.type === "comparison" || block.type === "scorecard") &&
      !comparison
    )
      throw new Error(
        `${block.type} requires an explicit comparison configuration.`
      )
    const referenced =
      block.type === "evidence"
        ? block.sectionIds
        : "sectionId" in block && block.sectionId
          ? [block.sectionId]
          : []
    for (const id of referenced) {
      if (!sectionIds.has(id)) throw new Error(`Unknown report section: ${id}`)
      if (block.type !== "brief") {
        if (placed.has(id))
          throw new Error(`Report section is placed more than once: ${id}`)
        placed.add(id)
      }
    }
  }
  if (comparison) {
    checkWidget(comparison.widgetId)
    const result = reportPresentationResult(report, comparison.widgetId)
    if (
      result.query.dimensions.length !== 1 ||
      result.query.dimensions[0] !== comparison.dimension ||
      result.query.timeDimensions.some((time) => time.granularity)
    )
      throw new Error("Comparison needs one captured categorical dimension.")
    const candidates = new Set(
      comparison.candidates.map((candidate) => candidate.value)
    )
    if (
      candidates.size !== comparison.candidates.length ||
      candidates.size !== result.data.length ||
      !candidates.has(comparison.baseline) ||
      !candidates.has(comparison.candidate)
    )
      throw new Error(
        "Comparison must include every captured candidate exactly once, including its baseline and selected candidate."
      )
    for (const candidate of comparison.candidates) {
      if (
        result.data.filter(
          (row) => row[comparison.dimension] === candidate.value
        ).length !== 1
      )
        throw new Error(
          "Each comparison candidate must resolve to one captured row."
        )
    }
    if (
      new Set(comparison.metrics.map((metric) => metric.member)).size !==
      comparison.metrics.length
    )
      throw new Error("Comparison metrics must be unique.")
    for (const metric of comparison.metrics) {
      const annotation = result.annotation.measures[metric.member]
      if (
        !result.query.measures.includes(metric.member) ||
        annotation?.type !== "number"
      )
        throw new Error(
          "Comparison metrics must reference captured numeric measures."
        )
      if (
        metric.target !== undefined &&
        (metric.direction === "neutral" ||
          (annotation.unit === "ratio" &&
            (metric.target < 0 || metric.target > 1)))
      )
        throw new Error(
          "Targets need a higher/lower direction; ratio targets must be between zero and one."
        )
    }
  }
  for (const metric of presentation.metrics) {
    if (
      !report.snapshot.evidence?.values.some(
        (v) => v.binding.id === metric.evidenceId
      )
    )
      throw new Error(`Unknown frozen evidence: ${metric.evidenceId}`)
  }
  for (const section of presentation.sections) {
    unique(section.id)
    section.widgets.forEach((w) => checkWidget(w.widgetId))
    for (const detail of section.details) {
      unique(detail.id)
      detail.widgets.forEach((w) => checkWidget(w.widgetId))
    }
    if (!section.progression) continue
    const p = section.progression
    checkWidget(p.widgetId)
    const result = reportPresentationResult(report, p.widgetId)
    if (
      result.query.dimensions.length !== 1 ||
      result.query.dimensions[0] !== p.dimension
    )
      throw new Error(
        "Progression needs a single captured categorical dimension."
      )
    if (
      new Set(p.stages.map((s) => s.value)).size !== p.stages.length ||
      p.stages.length !== result.data.length
    )
      throw new Error(
        "Progression must include each captured stage exactly once."
      )
    for (const measure of p.measures) {
      if (
        !result.query.measures.includes(measure.member) ||
        result.annotation.measures[measure.member]?.unit !== "ratio"
      )
        throw new Error("Progression measures must be captured ratios.")
      for (const stage of p.stages) {
        const rows = result.data.filter((r) => r[p.dimension] === stage.value)
        const value = rows[0]?.[measure.member]
        if (
          rows.length !== 1 ||
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1
        )
          throw new Error(
            "Each stage must resolve to one captured ratio between zero and one."
          )
      }
    }
  }
}
