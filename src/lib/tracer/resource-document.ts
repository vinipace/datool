import { z } from "zod"
import { scorerInputSchema } from "./scorers"
export const resourceDocumentSchema = z.discriminatedUnion("kind", [
  z.object({
    format: z.literal(1),
    kind: z.literal("dataset"),
    key: z.string().min(1),
    description: z.string().default(""),
    items: z
      .array(
        z.object({
          key: z.string().min(1),
          input: z.json(),
          expectedOutput: z.json().nullable().default(null),
          metadata: z.record(z.string(), z.json()).default({}),
        })
      )
      .max(10000),
  }),
  z.object({
    format: z.literal(1),
    kind: z.literal("scorer"),
    key: z.string().min(1),
    config: scorerInputSchema,
  }),
])
export type ResourceDocument = z.infer<typeof resourceDocumentSchema>
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
