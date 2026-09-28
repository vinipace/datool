import { z } from "zod"
import type { TraceViewData } from "./trace-view-contract"
import { invocationGroupSchema } from "./groups"
import { fieldReferenceSchema } from "./view-resources"

export const requirementTypes = [
  "any",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
] as const
// JSON Pointer paths avoid ambiguity in attribute names containing dots or slashes.
export const viewRequirementSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(/^\/(?:[^~]|~[01])*$/),
    type: z.enum(requirementTypes),
    required: z.boolean(),
    nonEmpty: z.boolean(),
  })
  .strict()
export type ViewRequirement = z.infer<typeof viewRequirementSchema>
export const viewRequirementsSchema = z
  .array(viewRequirementSchema)
  .max(100)
  .refine(
    (rows) => new Set(rows.map((row) => row.path)).size === rows.length,
    "Each field path must be unique."
  )
export const reactViewSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("trace"), id: z.string().min(1).max(200) })
    .strict(),
  z
    .object({ kind: z.literal("dataset-item"), id: z.string().min(1).max(200) })
    .strict(),
])
export type ReactViewSource = z.infer<typeof reactViewSourceSchema>
export const reactViewOriginSchema = z.object({
  source: reactViewSourceSchema,
  name: z.string(),
  datasetId: z.string().nullable(),
  datasetName: z.string().nullable(),
  traceId: z.string().nullable(),
  traceName: z.string().nullable(),
  operation: z.string().nullable(),
  group: invocationGroupSchema.nullable(),
})
export type ReactViewOrigin = z.infer<typeof reactViewOriginSchema>
export const reactViewInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    dataMode: z.enum(["full", "summary"]).default("full"),
    code: z.string().trim().min(1).max(100000),
    // null = unknown; [] = explicitly reviewed, no data requirements.
    requirements: viewRequirementsSchema.nullable(),
    objectTypes: z.array(z.enum(["trace", "dataset-item"])).min(1).max(2).default(["trace", "dataset-item"]),
    inputContract: z.enum(["legacy-trace", "object"]).default("legacy-trace"),
    customFields: z.array(fieldReferenceSchema).max(50).default([]),
  })
  .strict()
export const createReactViewSchema = reactViewInputSchema.extend({
  source: reactViewSourceSchema.nullable(),
})
export const updateReactViewSchema = reactViewInputSchema.extend({
  expectedRevision: z.number().int().positive(),
})
type ReactViewOptions = "objectTypes" | "inputContract" | "customFields"
export type ReactViewInput = Omit<z.infer<typeof reactViewInputSchema>, ReactViewOptions> & Partial<Pick<z.infer<typeof reactViewInputSchema>, ReactViewOptions>>
export const reactViewSchema = reactViewInputSchema.extend({
  id: z.string(),
  projectId: z.string(),
  revision: z.number().int().positive(),
  origin: reactViewOriginSchema.nullable(),
  author: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["session", "oauth", "api-key"]),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ReactView = Omit<z.infer<typeof reactViewSchema>, ReactViewOptions> & Partial<Pick<z.infer<typeof reactViewSchema>, ReactViewOptions>>
export type ReactViewSummary = Omit<ReactView, "code">
export type ReactViewPage = {
  items: ReactViewSummary[]
  nextCursor: string | null
}

export function pointerParts(path: string) {
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
}
export function pointerValue(value: unknown, path: string): unknown {
  for (const part of pointerParts(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
export function valueType(value: unknown): ViewRequirement["type"] {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (["string", "number", "boolean", "object"].includes(typeof value))
    return typeof value as ViewRequirement["type"]
  return "any"
}
export function viewCompatibility(
  requirements: ViewRequirement[] | null,
  trace: unknown,
  unloadedFields: string[] = []
) {
  if (requirements === null)
    return {
      state: "unknown" as const,
      label: "Unknown",
      reasons: ["Data requirements have not been reviewed."],
    }
  const reasons: string[] = []
  let unloaded = false
  for (const requirement of requirements) {
    if (unloadedFields.includes(pointerParts(requirement.path)[0])) {
      unloaded = true
      continue
    }
    const value = pointerValue(trace, requirement.path)
    if (value === undefined) {
      if (requirement.required) reasons.push(`Missing ${requirement.path}`)
      continue
    }
    if (requirement.type !== "any" && valueType(value) !== requirement.type) {
      reasons.push(
        `${requirement.path}: expected ${requirement.type}, received ${valueType(value)}`
      )
    } else if (
      requirement.nonEmpty &&
      (value === null ||
        value === "" ||
        (Array.isArray(value) && !value.length))
    ) {
      reasons.push(`${requirement.path} must not be empty`)
    }
  }
  return reasons.length
    ? { state: "missing" as const, label: "Requirements missing", reasons }
    : unloaded
      ? {
          state: "unknown" as const,
          label: "Unknown",
          reasons: ["Required trace details have not been loaded."],
        }
      : { state: "met" as const, label: "Requirements met", reasons: [] }
}
export function rankReactViews(
  views: ReactViewSummary[],
  trace: TraceViewData,
  objectInput?: { kind: "trace" | "dataset-item"; object: unknown }
) {
  const rank = { met: 0, unknown: 1, missing: 2 }
  const affinity = (view: ReactViewSummary) =>
    Number(
      !!view.origin?.operation && view.origin.operation === trace.operation
    ) +
    Number(
      !!trace.group &&
        view.origin?.group?.type === trace.group.type &&
        view.origin.group.name === trace.group.name
    )
  return views
    .map((view) => ({
      view,
      compatibility: viewCompatibility(
        view.requirements,
        view.inputContract === "object" && objectInput ? objectInput.object : trace,
        view.dataMode === "full" && !("spans" in trace)
          ? ["spans", "scores", "spanStats"]
          : []
      ),
    }))
    .sort(
      (a, b) =>
        rank[a.compatibility.state] - rank[b.compatibility.state] ||
        affinity(b.view) - affinity(a.view) ||
        a.view.name.localeCompare(b.view.name) ||
        a.view.id.localeCompare(b.view.id)
    )
}
