import { z } from "zod"

/** Membership is explicit and fixed at creation, independently of operation kind. */
export const invocationGroupSchema = z
  .object({
    type: z.enum(["agent", "workflow"]),
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
export type InvocationGroup = z.infer<typeof invocationGroupSchema>

export function namedInvocationGroup(
  type: InvocationGroup["type"],
  options: { name: string; group?: InvocationGroup | null }
): InvocationGroup {
  if (!options.name.trim()) throw new Error("Invocation name cannot be empty.")
  return invocationGroupSchema.parse(
    options.group ?? { type, name: options.name }
  )
}

export function otelInvocationGroup(
  attributes: Record<string, unknown>
): InvocationGroup | undefined {
  const type = attributes["datool.group.type"]
  const name = attributes["datool.group.name"]
  const version = attributes["datool.group.version"]
  if (type === undefined && name === undefined && version === undefined)
    return undefined
  return invocationGroupSchema.parse({ type, name, version })
}
