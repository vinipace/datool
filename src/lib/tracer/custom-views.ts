import { z } from "zod"
import { valueViews, type ValueView } from "./value-views"
import { fieldReferenceSchema, pageViewResourceSchema } from "./view-resources"
import { pageViewRendererSchema } from "./react-page-views"

const columnId = z.string().min(1).max(200)
const column = z
  .object({
    id: columnId,
    name: z.string().trim().min(1).max(120),
    code: z.string().max(20_000),
    mode: z.enum(["expression", "template"]),
    format: z.enum(["text", "markdown"]).optional(),
  })
  .strict()

// Resource and schemaVersion allow each future surface to own its settings
// contract without treating an eval layout as a trace/session layout.
export const evalViewSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    computedColumns: z
      .array(column)
      .max(50)
      .refine(
        (columns) => new Set(columns.map((c) => c.id)).size === columns.length,
        "Column IDs must be unique."
      ).default([]),
    columnOrder: z
      .array(columnId)
      .max(200)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Column order must be unique."
      ).default([]),
    columnVisibility: z.record(columnId, z.boolean()).default({}),
    columnSizing: z.record(columnId, z.number().min(44).max(1200)).default({}),
    view: z.enum(["table", "cards"]).default("table"),
    rowHeight: z.enum(["compact", "tall"]).optional(),
    detailsOpen: z.boolean().default(false),
    renderer: pageViewRendererSchema.optional(),
    fieldViews: z.record(columnId, z.enum(valueViews)).optional(),
    customFields: z.array(fieldReferenceSchema).max(50).optional(),
    queryParams: z.record(columnId, z.array(z.string().max(4000)).max(50)).optional(),
    pageSettings: z.record(columnId, z.json()).optional(),
    objectViews: z.partialRecord(z.enum(["trace", "dataset-item"]), fieldReferenceSchema.nullable()).optional(),
    query: z.object({
      resource: z.enum(["traces", "eval-results"]),
      columns: z.array(z.object({ id: columnId, label: z.string(), selector: z.string(), format: z.enum(["boolean", "json", "number", "text"]) }).strict()).min(1).max(50),
      filters: z.array(z.object({ selector: z.string(), operator: z.enum(["equals", "exists", "notEquals"]), value: z.json().optional() }).strict()).max(20),
      sort: z.object({ selector: z.string(), direction: z.enum(["asc", "desc"]) }).strict().nullable(),
    }).strict().optional(),
  })
  .strict()

export const customViewInputSchema = z
  .object({
    resource: pageViewResourceSchema,
    name: z.string().trim().min(1).max(120),
    settings: evalViewSettingsSchema,
  })
  .strict()
export const customViewUpdateSchema = customViewInputSchema.extend({
  expectedRevision: z.number().int().positive(),
})
export type EvalViewSettings = z.infer<typeof evalViewSettingsSchema>
export type CustomViewInput = z.infer<typeof customViewInputSchema>
export type CustomView = CustomViewInput & {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export const customViewSchema = customViewInputSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CollectionTableSettings = Pick<
  EvalViewSettings,
  "columnVisibility" | "columnSizing" | "view" | "rowHeight"
> & { fieldViews?: Record<string, ValueView> }
export const defaultTableSettings: CollectionTableSettings = {
  columnVisibility: {},
  columnSizing: {},
  view: "table",
}

export function sameViewSettings(a: EvalViewSettings, b: EvalViewSettings) {
  // Object insertion order is not a layout change.
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
          )
        : item
    )
  const normalize = (value: EvalViewSettings) => ({
    ...value,
    rowHeight: value.rowHeight ?? "compact",
    customFields: value.customFields ?? [],
    fieldViews: value.fieldViews ?? {},
    queryParams: value.queryParams ?? {},
    pageSettings: value.pageSettings ?? {},
    objectViews: value.objectViews ?? {},
    columnVisibility: Object.fromEntries(Object.entries(value.columnVisibility).filter(([, visible]) => !visible)),
  })
  return stable(normalize(a)) === stable(normalize(b))
}

export function viewHistory(
  storage: Pick<Storage, "getItem" | "setItem">,
  id: string
) {
  const key = `datool:custom-view-history:${id}`
  const read = () =>
    z
      .array(customViewSchema)
      .parse(JSON.parse(storage.getItem(key) ?? "[]"))
      .filter((view) => view.id === id)
  return {
    read,
    remember: (...views: CustomView[]) => {
      const revisions = new Map(read().map((view) => [view.revision, view]))
      views.forEach((view) => {
        if (view.id === id) revisions.set(view.revision, view)
      })
      storage.setItem(
        key,
        JSON.stringify(
          [...revisions.values()]
            .sort((a, b) => b.revision - a.revision)
            .slice(0, 50)
        )
      )
    },
  }
}
