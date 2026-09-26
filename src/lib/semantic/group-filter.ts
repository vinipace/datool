import { z } from "zod"
import { invocationGroupSchema } from "@/src/lib/tracer/groups"
import type { SemanticDimensionDefinition } from "./model"

export const invocationSelectionSchema = invocationGroupSchema
  .omit({ version: true })
  .extend({
    versions: z
      .array(z.string().min(1).max(200).nullable())
      .min(1)
      .max(6)
      .optional(),
  })
  .strict()
export type InvocationSelection = z.infer<typeof invocationSelectionSchema>

export function invocationFilterMember(
  model: string,
  version: string
): SemanticDimensionDefinition {
  return {
    name: `${model}.invocationGroup`,
    kind: "dimension",
    type: "string",
    title: "Invocation group",
    metricVersion: version,
    groupable: false,
    filterOperators: ["equals", "in"],
    description: "Filter by explicit agent or workflow membership.",
    definition:
      "Values are JSON objects with type, name and optional versions. Names and versions match exactly. Logs and traces include the full trace containing a matching invocation; performance models filter their own invocations directly and other group types by trace membership.",
  }
}
