import { z } from "zod"

export const widgetPreviewOptionsSchema = z.object({
  state: z.string().min(1).max(120).default("default"),
  allowEmpty: z.boolean().default(false),
})

export type WidgetDiagnostic = {
  code: string
  severity: "error" | "warning"
  message: string
}

// The opaque iframe runs user code; accept only bounded, well-formed observations.
export const widgetPreviewReportSchema = z.object({
  rendered: z.boolean(),
  valid: z.boolean(),
  schemaValidated: z.boolean(),
  diagnostics: z
    .array(
      z.object({
        code: z.string().max(120),
        severity: z.enum(["error", "warning"]),
        message: z.string().max(2000),
      })
    )
    .max(100),
  text: z.string().max(4000).optional(),
  imageCount: z.number().int().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
})
export type WidgetPreviewReport = z.infer<typeof widgetPreviewReportSchema>
