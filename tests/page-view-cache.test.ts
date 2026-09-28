import { expect, test } from "bun:test"
import { createPageViewCache } from "@/src/lib/tracer/page-view-cache"
import type { CustomView } from "@/src/lib/tracer/custom-views"

const view: CustomView = { id: "saved", name: "Review", resource: "traces", revision: 1, createdAt: "2026-09-28", updatedAt: "2026-09-28", settings: { schemaVersion: 1, computedColumns: [], columnOrder: [], columnVisibility: {}, columnSizing: {}, view: "table", detailsOpen: false } }

test("concurrent mounts and selected views share one catalog request", async () => {
  const cache = createPageViewCache()
  let lists = 0, reads = 0
  const load = async () => { lists++; return [view] }
  const get = async () => { reads++; return view }
  const results = await Promise.all([cache.list("a", "traces", load), cache.list("a", "traces", load), cache.get("a", "saved", get)])
  expect(lists).toBe(1)
  expect(reads).toBe(0)
  expect(results[2]).toEqual(view)
  await cache.list("a", "traces", load)
  await cache.get("a", "saved", get)
  expect(lists).toBe(1)
  expect(reads).toBe(0)
  await cache.list("b", "traces", load)
  expect(lists).toBe(2)
})

test("explicit saves and deletes update cached menus without refetching", async () => {
  const cache = createPageViewCache()
  const load = async () => [view]
  await cache.list("a", "traces", load)
  cache.remember("a", { ...view, name: "Updated", revision: 2 })
  cache.remember("a", { ...view, id: "copy", name: "Copy" })
  const items = await cache.list("a", "traces", load)
  expect(items.map(item => item.name)).toEqual(["Updated", "Copy"])
  cache.remove("a", "saved")
  expect((await cache.list("a", "traces", load)).map(item => item.id)).toEqual(["copy"])
})

test("failed catalog loads can retry and explicit reset reads the current revision", async () => {
  const cache = createPageViewCache()
  let failed = false
  try { await cache.list("a", "traces", async () => { throw new Error("Offline") }) } catch { failed = true }
  expect(failed).toBe(true)
  expect(await cache.list("a", "traces", async () => [view])).toEqual([view])
  const updated = await cache.get("a", "saved", async () => ({ ...view, revision: 2 }), true)
  expect(updated.revision).toBe(2)
})
