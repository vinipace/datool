import { z } from "zod"
import { customViewInputSchema, customViewUpdateSchema } from "./custom-views"
import { customFieldInputSchema, customFieldUpdateSchema } from "./custom-fields"
import { createObjectViewSchema, updateObjectViewSchema } from "./object-views"
import { objectTypeSchema, viewPreferenceSchema, type ViewResourceKind } from "./view-resources"

const id = z.string().min(1).max(200)
const revision = z.number().int().positive()
export const viewListSchema = z.object({ cursor: id.optional(), limit: z.number().int().min(1).max(100).default(50), search: z.string().max(200).optional(), resource: z.string().optional() }).strict()
export const fieldEvaluationSchema = z.object({ id, revision: revision.optional(), kind: objectTypeSchema, rows: z.array(z.record(z.string(), z.json())).min(1).max(20) }).strict()
export const objectPreviewSchema = z.object({ id, revision: revision.optional(), kind: z.enum(["trace", "dataset-item"]), object: z.json(), context: z.record(z.string(), z.json()).default({}) }).strict()
export type ViewOperation = { name: string; description: string; kind?: ViewResourceKind; action: string; write: boolean; schema: z.ZodObject }
export const viewOperations: ViewOperation[] = []
for (const [kind, singular, plural, create, update] of [
  ["page-view", "page_view", "page_views", customViewInputSchema, customViewUpdateSchema],
  ["custom-field", "custom_field", "custom_fields", customFieldInputSchema, customFieldUpdateSchema],
  ["object-view", "object_view", "object_views", createObjectViewSchema, updateObjectViewSchema],
] as const) {
  const add = (action: string, name: string, description: string, schema: z.ZodObject, write = false) => viewOperations.push({ kind, action, name, description, schema, write })
  add("list", `list_${plural}`, `List project ${plural.replaceAll("_", " ")} with bounded pagination. Follow nextCursor.`, viewListSchema)
  add("get", `get_${singular}`, `Read a ${kind}, including source/settings and current or pinned revision.`, z.object({ id, revision: revision.optional() }))
  add("create", `create_${singular}`, `Create a shared ${kind}. Page Views reference existing fields and never edit their definitions.`, z.object({ definition: create }), true)
  add("update", `update_${singular}`, `Update a shared ${kind} using expectedRevision. Stale writes return CONFLICT.`, z.object({ id, definition: update }), true)
  add("copy", `copy_${singular}`, `Copy a ${kind} under a new name.`, z.object({ id, name: z.string().trim().min(1).max(120) }), true)
  add("delete", `delete_${singular}`, `Delete a ${kind} at expectedRevision. Referenced definitions must be detached first.`, z.object({ id, expectedRevision: revision }), true)
  add("history", `get_${singular}_history`, `Read immutable ${kind} revisions. before paginates older revisions.`, z.object({ id, before: revision.optional() }))
  add("restore", `restore_${singular}`, `Restore a historical ${kind} as a new revision without modifying its dependencies.`, z.object({ id, revision, expectedRevision: revision }), true)
  add("dependencies", `get_${singular}_dependencies`, `List definitions referencing this ${kind}; hasMore reports truncation.`, z.object({ id }))
  add("validate", `validate_${singular}`, `Validate a ${kind} and its dependencies. This does not execute formulas or render React.`, z.object({ definition: create }))
}
viewOperations.push(
  { name: "get_view_capabilities", description: "Discover Page View resources, Custom Field object types, execution limits and supported operations.", action: "capabilities", write: false, schema: z.object({}) },
  { name: "resolve_page_view", description: "Resolve a Page View, its exact field/Object View dependencies and workspace-relative link before applying it.", kind: "page-view", action: "resolve", write: false, schema: z.object({ id, revision: revision.optional() }) },
  { name: "get_page_view_data", description: "Query a Page View with data permissions. Unsupported query operations are explicitly rejected; rows are never filtered after pagination.", kind: "page-view", action: "data", write: false, schema: z.object({ id, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().nonnegative().optional(), runId: id.optional() }) },
  { name: "evaluate_custom_field", description: "Evaluate up to 20 supplied rows in the bounded local sandbox, returning typed values and per-row diagnostics. Does not fetch records or call model providers.", kind: "custom-field", action: "evaluate", write: false, schema: fieldEvaluationSchema },
  { name: "preview_object_view", description: "Compile an Object View and check input compatibility. Returns rendered:false; use the browser sandbox for actual rendering.", kind: "object-view", action: "preview", write: false, schema: objectPreviewSchema },
  { name: "get_view_preference", description: "Read the authenticated principal's durable project/page preference. Revision zero means unset.", action: "preference", write: false, schema: z.object({ scope: z.string().min(1).max(500) }) },
  { name: "save_view_preference", description: "Save the authenticated principal's durable project/page preference using expectedRevision. Does not edit shared definitions.", action: "savePreference", write: true, schema: viewPreferenceSchema },
)
