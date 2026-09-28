import { expect, test } from "bun:test"
import { createPageViewDraftStore, createPageViewSelectionStore } from "@/src/lib/tracer/page-view-drafts"
import { sameViewSettings, type CustomView, type EvalViewSettings } from "@/src/lib/tracer/custom-views"

const settings: EvalViewSettings = { schemaVersion: 1, computedColumns: [], columnOrder: [], columnVisibility: {}, columnSizing: {}, view: "table", detailsOpen: false }
const view: CustomView = { id: "saved", name: "Review", resource: "traces", revision: 3, createdAt: "2026-09-28", updatedAt: "2026-09-28", settings }
function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

test("drafts retain filters, display settings and the original revision across reloads and view switches", () => {
  const storage = memoryStorage()
  const drafts = createPageViewDraftStore("project-a:logs", () => storage)
  const changed = { ...settings, rowHeight: "tall" as const, fieldViews: { output: "yaml" as const }, queryParams: { filter: ['status = "error"'] } }
  drafts.write(view.id, { base: view, settings: changed })
  drafts.write(null, { base: null, settings: { ...settings, view: "cards" } })
  const reloaded = createPageViewDraftStore("project-a:logs", () => storage)
  expect(reloaded.read(view.id)).toEqual({ base: view, settings: changed })
  expect(reloaded.read(null)?.settings.view).toBe("cards")
  expect(createPageViewDraftStore("project-b:logs", () => storage).read(view.id)).toBeNull()
  expect(createPageViewDraftStore("project-a:dataset", () => storage).read(view.id)).toBeNull()
  reloaded.clear(view.id)
  expect(createPageViewDraftStore("project-a:logs", () => storage).read(view.id)).toBeNull()
  expect(reloaded.read(null)).not.toBeNull()
})

test("unavailable browser storage reports the failure while retaining the in-memory draft", () => {
  const drafts = createPageViewDraftStore("logs", () => { throw new Error("Storage disabled") })
  drafts.write(view.id, { base: view, settings })
  expect(drafts.getError()).toContain("could not be stored")
  expect(drafts.read(view.id)?.base?.revision).toBe(3)
})

test("malformed drafts are not silently erased or treated as saved", () => {
  const storage = memoryStorage()
  storage.setItem("logs:draft:saved", "broken")
  expect(() => createPageViewDraftStore("logs", () => storage).read("saved")).toThrow()
  expect(storage.getItem("logs:draft:saved")).toBe("broken")
})

test("selected views are local and scoped, including returning to the default view", () => {
  const storage = memoryStorage()
  const first = createPageViewSelectionStore("logs:selected", () => storage)
  first.set("saved")
  const reloaded = createPageViewSelectionStore("logs:selected", () => storage)
  reloaded.load()
  expect(reloaded.getSnapshot()).toEqual({ id: "saved", loaded: true, error: "" })
  reloaded.set(null)
  first.load()
  expect(first.getSnapshot().id).toBeNull()
})

test("equivalent defaults do not mark a Page View changed; real filters and display changes do", () => {
  expect(sameViewSettings(settings, { ...settings, rowHeight: "compact", customFields: [], fieldViews: {}, queryParams: {}, columnVisibility: { output: true } })).toBe(true)
  expect(sameViewSettings(settings, { ...settings, columnVisibility: { output: false } })).toBe(false)
  expect(sameViewSettings(settings, { ...settings, queryParams: { filter: ["status = error"] } })).toBe(false)
})

test("restored preferences establish a clean baseline once, while subsequent edits remain drafts after reload", () => {
  const storage = memoryStorage()
  const restored: EvalViewSettings = { ...settings, rowHeight: "tall", columnSizing: { input: 320 }, fieldViews: { output: "yaml" } }
  const first = createPageViewDraftStore("logs", () => storage)
  expect(sameViewSettings(first.defaultBaseline(restored), restored)).toBe(true)
  expect(first.read(null)).toBeNull()
  const changed: EvalViewSettings = { ...restored, rowHeight: "compact", queryParams: { filter: ['status = "errored"'] } }
  first.write(null, { base: null, settings: changed })
  const reloaded = createPageViewDraftStore("logs", () => storage)
  expect(reloaded.defaultBaseline(changed)).toEqual(restored)
  expect(sameViewSettings(reloaded.defaultBaseline(changed), reloaded.read(null)!.settings)).toBe(false)
  reloaded.clear(null)
  expect(createPageViewDraftStore("logs", () => storage).defaultBaseline(settings)).toEqual(restored)
})

test("drafts created before baseline tracking retain their unsaved edits", () => {
  const storage = memoryStorage()
  const changed: EvalViewSettings = { ...settings, view: "cards" }
  storage.setItem("logs:draft:default", JSON.stringify({ base: null, settings: changed }))
  const reloaded = createPageViewDraftStore("logs", () => storage)
  expect(reloaded.defaultBaseline(settings)).toEqual(settings)
  expect(sameViewSettings(reloaded.defaultBaseline(settings), reloaded.read(null)!.settings)).toBe(false)
})
