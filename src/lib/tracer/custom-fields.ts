import { z } from "zod"
import { objectTypeSchema } from "./view-resources"
import { valueViews } from "./value-views"

export const customFieldInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  code: z.string().max(20_000),
  mode: z.enum(["expression", "template"]),
  format: z.enum([...valueViews, "markdown"]).default("text"),
  objectTypes: z.array(objectTypeSchema).min(1).max(30).default(["trace", "dataset-item", "agent", "workflow"]),
  resultType: z.enum(["any", "string", "number", "boolean", "object", "array"]).default("any"),
}).strict()
export const customFieldSchema = customFieldInputSchema.extend({
  id: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CustomField = z.infer<typeof customFieldSchema>
export const customFieldUpdateSchema = customFieldInputSchema.extend({ expectedRevision: z.number().int().positive() })
export function fieldSupportsObject(field: Pick<CustomField, "objectTypes">, kind: z.infer<typeof objectTypeSchema>) {
  return field.objectTypes.includes(kind) || (kind === "eval-result" || kind === "review-item") && field.objectTypes.includes("trace")
}
