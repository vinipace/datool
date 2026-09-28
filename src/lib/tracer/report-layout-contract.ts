import { z } from "zod"

export const reportLayoutSchema = z.enum([
  "canvas",
  "document",
  "brief",
  "comparison",
  "scorecard",
])
export type ReportLayout = z.infer<typeof reportLayoutSchema>
export const reportComparisonSchema = z
  .object({
    widgetId: z.string().min(1).max(100),
    dimension: z.string().min(1),
    candidates: z
      .array(
        z
          .object({ value: z.string(), label: z.string().min(1).max(200) })
          .strict()
      )
      .min(2)
      .max(8),
    baseline: z.string(),
    candidate: z.string(),
    metrics: z
      .array(
        z
          .object({
            member: z.string().min(1),
            label: z.string().min(1).max(200),
            direction: z
              .enum(["higher", "lower", "neutral"])
              .default("neutral"),
            target: z.number().finite().optional(),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict()
export type ReportComparison = z.infer<typeof reportComparisonSchema>
