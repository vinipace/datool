import { createTracerFixture, closeTracerFixture, reopenTracerFixture } from "./helpers/tracer-fixture"
import { closeTracerDatabase } from "../src/server/tracer/db"
import { describe, expect, test } from "bun:test"
import {
  createTracerDatabase,
} from "@/src/server/tracer/db"
import { createCustomViewService } from "@/src/server/tracer/custom-views"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import {
  customViewInputSchema,
  sameViewSettings,
  viewHistory,
  type CustomView,
  type EvalViewSettings,
} from "@/src/lib/tracer/custom-views"

const settings: EvalViewSettings = {
  schemaVersion: 1,
  computedColumns: [
    {
      id: "cost",
      name: "BRL",
      code: "R${{row.metrics.cost*5.5}}",
      mode: "template",
    },
  ],
  columnOrder: ["computed:cost", "name", "output", "input"],
  columnVisibility: { input: false },
  columnSizing: { output: 440 },
  view: "cards",
  detailsOpen: false,
}
const input = { name: "Cost review", resource: "eval-runs" as const, settings }
function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

async function expectRejected(promise: Promise<unknown>, message: string) {
  let caught: unknown
  try { await promise } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain(message)
}

describe("custom eval views", () => {
  test("persists across connections, handles concurrent writes, and restores a local revision as a new DB revision", async () => {
    const db = await createTracerFixture()
    let second: ReturnType<typeof createTracerDatabase> | undefined
    try {
      const service = createCustomViewService(db)
      const playgroundView = await run(service.create({ ...input, resource: "playground-traces" }))
      expect(await run(service.list("playground-traces"))).toEqual([playgroundView])
      const initial = await run(service.create(input))
      const groupViews = await Promise.all(["agents", "workflows", "scorers"].map(resource =>
        run(service.create({ ...input, resource, settings: {
          ...settings,
          computedColumns: [{ id: "completed", name: "Completed", code: "row.metrics.completedCount", mode: "expression" }],
          columnOrder: ["computed:completed", "name", "count"],
          columnVisibility: { count: false },
          columnSizing: { name: 360 },
        } }))
      ))
      expect(initial.revision).toBe(1)
      expect(initial.settings).toEqual(settings)
      second = reopenTracerFixture(db)
      const otherBrowser = createCustomViewService(second)
      expect(await run(otherBrowser.get(initial.id))).toEqual(initial)
      expect(await run(otherBrowser.list("eval-runs"))).toEqual([initial])
      for (const view of groupViews) {
        expect(await run(otherBrowser.list(view.resource))).toEqual([view])
        expect(await run(otherBrowser.get(view.id))).toEqual(view)
      }
      const history = viewHistory(memoryStorage(), initial.id)
      history.remember(initial)
      const changed = {
        ...settings,
        view: "table" as const,
        computedColumns: [],
        columnOrder: ["name", "output", "input"],
      }
      const results = await Promise.allSettled([
        run(
          service.update(initial.id, {
            ...input,
            settings: changed,
            expectedRevision: 1,
          })
        ),
        run(
          otherBrowser.update(initial.id, {
            ...input,
            settings: changed,
            expectedRevision: 1,
          })
        ),
      ])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
      const current = await run(service.get(initial.id))
      expect(current.revision).toBe(2)
      history.remember(current)
      const old = history.read().find((v) => v.revision === 1)!
      const restored = await run(
        service.update(initial.id, {
          name: old.name,
          resource: old.resource,
          settings: old.settings,
          expectedRevision: current.revision,
        })
      )
      expect(restored.settings).toEqual(settings)
      expect(restored.revision).toBe(3)
      expect(restored.createdAt).toBe(initial.createdAt)
      await expectRejected(run(service.delete(initial.id, 2)), "changed in another browser")
      expect(await run(otherBrowser.get(initial.id))).toEqual(restored)
      await run(service.delete(initial.id, 3))
      await expectRejected(run(otherBrowser.get(initial.id)), "was not found")
      expect(await run(service.list("eval-runs"))).toEqual([])
      expect(await run(service.list("traces"))).toEqual([])
      await expectRejected(run(service.list("unsupported-resource")), "Unsupported")
    } finally {
      if (second) await closeTracerDatabase(second)
      await closeTracerFixture(db)
    }
  })

  test("rejects malformed layouts and unregistered resource contracts", () => {
    expect(customViewInputSchema.safeParse(input).success).toBe(true)
    expect(customViewInputSchema.safeParse({ ...input, resource: "scorers", settings: { ...settings, computedColumns: [] } }).success).toBe(true)
    for (const invalid of [
      { ...input, resource: "unsupported-resource" },
      { ...input, name: "  " },
      { ...input, settings: { ...settings, schemaVersion: 2 } },
      { ...input, settings: { ...settings, columnSizing: { input: -1 } } },
      { ...input, settings: { ...settings, columnOrder: ["input", "input"] } },
      {
        ...input,
        settings: {
          ...settings,
          computedColumns: [
            ...settings.computedColumns,
            ...settings.computedColumns,
          ],
        },
      },
    ])
      expect(customViewInputSchema.safeParse(invalid).success).toBe(false)
  })

  test("local history is immutable, deduplicated, bounded and isolated per view", () => {
    const storage = memoryStorage()
    const history = viewHistory(storage, "a")
    const view: CustomView = {
      ...input,
      id: "a",
      revision: 1,
      createdAt: "2026-09-07",
      updatedAt: "2026-09-07",
    }
    history.remember(view)
    const original = history.read()[0]
    history.remember({
      ...view,
      revision: 2,
      settings: { ...settings, computedColumns: [] },
    })
    expect(original.settings.computedColumns).toHaveLength(1)
    for (let revision = 1; revision <= 60; revision++)
      history.remember({ ...view, revision })
    expect(history.read()).toHaveLength(50)
    expect(history.read().map((v) => v.revision)).toEqual(
      Array.from({ length: 50 }, (_, i) => 60 - i)
    )
    expect(viewHistory(storage, "b").read()).toEqual([])
    expect(() =>
      viewHistory(
        {
          ...storage,
          setItem: () => {
            throw new Error("quota")
          },
        },
        "a"
      ).remember(view)
    ).toThrow("quota")
    storage.setItem("datool:custom-view-history:a", "invalid json")
    expect(() => history.read()).toThrow()
  })

  test("dirty detection ignores object key order but includes formulas, layout and panel settings", () => {
    const original = { ...settings, columnSizing: { input: 200, output: 300 } }
    expect(
      sameViewSettings(original, {
        ...original,
        columnSizing: { output: 300, input: 200 },
      })
    ).toBe(true)
    for (const changed of [
      { ...original, detailsOpen: true },
      { ...original, view: "table" as const },
      { ...original, computedColumns: [] },
      { ...original, columnOrder: [...original.columnOrder].reverse() },
    ])
      expect(sameViewSettings(original, changed)).toBe(false)
  })
})
