import { z } from "zod"
import type { ValueView } from "./value-views"

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
      ),
    columnOrder: z
      .array(columnId)
      .max(200)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Column order must be unique."
      ),
    columnVisibility: z.record(columnId, z.boolean()),
    columnSizing: z.record(columnId, z.number().min(44).max(1200)),
    view: z.enum(["table", "cards"]),
    rowHeight: z.enum(["compact", "tall"]).optional(),
    detailsOpen: z.boolean(),
  })
  .strict()

export const customViewInputSchema = z
  .object({
    resource: z.enum(["eval-runs", "playground-traces", "agents", "workflows", "scorers", "prompts"]),
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
export type LogTableSettings = Pick<
  EvalViewSettings,
  "columnVisibility" | "columnSizing" | "view" | "rowHeight"
> & { fieldViews?: Record<string, ValueView> }
export const defaultTableSettings: LogTableSettings = {
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
  return stable({ ...a, rowHeight: a.rowHeight ?? "compact" }) === stable({ ...b, rowHeight: b.rowHeight ?? "compact" })
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
