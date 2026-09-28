import { z } from "zod"

/** Authored through report APIs only; selectors address frozen dimension values. */
export const reportHighlightSchema = z
  .object({
    measure: z.string().min(1).max(200).optional(),
    widgetId: z.string().min(1).max(100),
    dimensions: z
      .record(
        z.string().min(1),
        z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
      )
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= 10,
        "Select between one and ten dimensions."
      ),
    label: z.string().trim().min(1).max(120),
  })
  .strict()

export type ReportHighlight = z.infer<typeof reportHighlightSchema>

export function matchesReportHighlight(
  highlight: ReportHighlight,
  row: Record<string, unknown>
) {
  return Object.entries(highlight.dimensions).every(
    ([field, value]) => row[field] === value
  )
}

export const reportReferenceSchema = z
  .object({
    widgetId: z.string().min(1).max(100),
    measure: z.string().min(1).max(200),
    value: z.number().finite(),
    label: z.string().trim().min(1).max(120),
  })
  .strict()
export type ReportReference = z.infer<typeof reportReferenceSchema>
