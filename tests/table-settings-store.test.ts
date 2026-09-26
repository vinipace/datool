import { expect, test } from "bun:test"
import { createTableSettingsStore } from "@/src/lib/tracer/table-settings-store"
import { defaultTableSettings, evalViewSettingsSchema, sameViewSettings } from "@/src/lib/tracer/custom-views"

test("unpersisted tables retain their defaults without accessing browser storage", () => {
  const store = createTableSettingsStore(undefined, () => { throw new Error("Storage unavailable") }, { ...defaultTableSettings, view: "cards" })
  store.load()
  expect(store.getSnapshot().settings.view).toBe("cards")
  store.set(current => ({ ...current, view: "table", rowHeight: "tall" }))
  expect(store.getSnapshot().error).toBe("")
  expect(store.getSnapshot().settings.rowHeight).toBe("tall")
})

test("saved views accept density and legacy views still mean compact", () => {
  const legacy = { ...defaultTableSettings, schemaVersion: 1 as const, computedColumns: [], columnOrder: [], detailsOpen: true }
  expect(evalViewSettingsSchema.parse({ ...legacy, rowHeight: "tall" }).rowHeight).toBe("tall")
  expect(sameViewSettings(legacy, { ...legacy, rowHeight: "compact" })).toBe(true)
  expect(sameViewSettings(legacy, { ...legacy, rowHeight: "tall" })).toBe(false)
  expect(evalViewSettingsSchema.safeParse({ ...legacy, rowHeight: "huge" }).success).toBe(false)
})

test("visibility, sizing and presentation survive remounts and are isolated per app", () => {
  const data = new Map<string, string>()
  const storage = () => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
  const first = createTableSettingsStore("app-a", storage)
  first.load()
  first.set(current => ({ ...current, view: "cards", rowHeight: "tall", columnVisibility: { input: false }, columnSizing: { output: 360 } }))
  const remounted = createTableSettingsStore("app-a", storage)
  remounted.load()
  expect(remounted.getSnapshot().settings).toEqual(first.getSnapshot().settings)
  const other = createTableSettingsStore("app-b", storage)
  other.load()
  expect(other.getSnapshot().settings.view).toBe("table")
  expect(other.getSnapshot().settings.rowHeight).toBeUndefined()
  data.set("app-a", "broken")
  remounted.load()
  expect(remounted.getSnapshot().error).toContain("could not be loaded")
  expect(data.get("app-a")).toBe("broken")
})

test("field views persist independently without overwriting table settings", () => {
  const data = new Map<string, string>()
  const storage = () => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
  const store = createTableSettingsStore("dataset-a", storage)
  store.load()
  store.set(current => ({ ...current, rowHeight: "tall", fieldViews: { input: "yaml", expectedOutput: "text", metadata: "tree" } }))
  store.set(current => ({ ...current, fieldViews: { ...current.fieldViews, input: "pretty" } }))
  const remounted = createTableSettingsStore("dataset-a", storage)
  remounted.load()
  expect(remounted.getSnapshot().settings.fieldViews).toEqual({ input: "pretty", expectedOutput: "text", metadata: "tree" })
  expect(remounted.getSnapshot().settings.rowHeight).toBe("tall")
  const other = createTableSettingsStore("dataset-b", storage)
  other.load()
  expect(other.getSnapshot().settings.fieldViews).toBeUndefined()
})
