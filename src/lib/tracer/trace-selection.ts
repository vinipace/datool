import { z } from "zod"

const traceIds = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  )
  .min(1)
  .max(500)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Trace IDs must be unique."
  )

export const traceSelectionMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), traceIds }).strict(),
  z
    .object({
      action: z.literal("tag"),
      traceIds,
      tags: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    })
    .strict(),
])

export type TraceSelectionMutation = z.infer<
  typeof traceSelectionMutationSchema
>
