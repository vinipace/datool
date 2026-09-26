import { describe, expect, test } from "bun:test"
import { createDashboardAutosave } from "@/src/lib/tracer/dashboard-autosave"
import {
  dashboardInputSchema,
  dashboardWidgetSchema,
  type Dashboard,
  type DashboardInput,
} from "@/src/lib/tracer/dashboards"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import {
  dashboardCanvasWidgets,
  appendDashboardWidget,
  applyDashboardLayout,
} from "@/components/tracer/dashboard-canvas-layout"

const initial: Dashboard = {
  id: "test",
  schemaVersion: 1,
  revision: 1,
  name: "Empty",
  description: "",
  widgets: [],
  createdAt: "2026-09-11",
  updatedAt: "2026-09-11",
}
const widget = dashboardWidgetSchema.parse({
  id: "metric",
  title: "Traces",
  type: "metric",
  width: 1,
  query: semanticQuerySchema.parse({
    measures: ["traces.count"],
    timeDimensions: [
      {
        dimension: "traces.startedAt",
        dateRange: ["2026-09-08T00:00:00Z", "2026-09-11T00:00:00Z"],
      },
    ],
  }),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("dashboard canvas persistence", () => {
  test("supports an empty dashboard and rejects invalid coordinates", () => {
    expect(
      dashboardInputSchema.parse({
        schemaVersion: 1,
        name: "Empty",
        description: "",
        widgets: [],
      }).widgets
    ).toEqual([])
    for (const layout of [
      { x: 10, y: 0, w: 4, h: 3 },
      { x: 0, y: -1, w: 4, h: 3 },
      { x: 0, y: 0, w: 4, h: 1 },
      { x: 0, y: 0, w: 4.5, h: 3 },
    ]) {
      expect(
        dashboardWidgetSchema.safeParse({ ...widget, layout }).success
      ).toBe(false)
    }
  })
  test("projects legacy widths, preserves queries, and persists layout after edits/add/remove", () => {
    const legacy = [widget, { ...widget, id: "wide", width: 2 as const }]
    const canvas = dashboardCanvasWidgets(legacy)
    expect(canvas.map((w) => [w.layout.x, w.layout.y, w.layout.w])).toEqual([
      [0, 0, 4],
      [4, 0, 8],
    ])
    expect(legacy[0].layout).toBeUndefined()
    const moved = applyDashboardLayout(legacy, [
      { id: "metric", layout: { x: 0, y: 5, w: 6, h: 7 } },
      { id: "wide", layout: { x: 0, y: 0, w: 12, h: 5 } },
    ])
    const roundtrip = JSON.parse(JSON.stringify(moved))
    expect(
      dashboardCanvasWidgets(roundtrip).map((w) => [
        w.layout.x,
        w.layout.y,
        w.layout.w,
        w.layout.h,
      ])
    ).toEqual([
      [0, 5, 6, 7],
      [0, 0, 12, 5],
    ])
    expect(moved[0].query).toEqual(widget.query)
    const appended = appendDashboardWidget(moved, { ...widget, id: "new" })
    expect(appended.every((w) => w.layout)).toBe(true)
    expect(appended[2].layout).toEqual({ x: 6, y: 5, w: 4, h: 3 })
    const remaining = appended.filter((w) => w.id !== "wide")
    const compacted = applyDashboardLayout(
      remaining,
      dashboardCanvasWidgets(remaining).map(({ id, layout }) => ({
        id,
        layout,
      }))
    )
    expect(compacted.every((w) => w.layout?.y === 0)).toBe(true)
  })
  test("serializes revisions and never replaces edits made during an earlier save", async () => {
    const writes: {
      config: DashboardInput
      revision: number
      done: ReturnType<typeof deferred<Dashboard>>
    }[] = []
    const store = createDashboardAutosave({
      initial,
      delay: 10000,
      save: (config, revision) => {
        const done = deferred<Dashboard>()
        writes.push({ config, revision, done })
        return done.promise
      },
    })
    store.update((c) => ({ ...c, name: "First" }))
    const saving = store.flush()
    store.update((c) => ({
      ...c,
      name: "Latest",
      description: "Also changed",
      widgets: [widget],
    }))
    expect(writes).toHaveLength(1)
    writes[0].done.resolve({ ...initial, ...writes[0].config, revision: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    expect(writes[1].revision).toBe(2)
    expect(writes[1].config.name).toBe("Latest")
    expect(store.getSnapshot().config.description).toBe("Also changed")
    writes[1].done.resolve({ ...initial, ...writes[1].config, revision: 3 })
    await saving
    expect(store.pending()).toBe(false)
    expect(store.getSnapshot().saved.widgets).toEqual([widget])
    expect(store.getSnapshot().status).toBe("saved")
  })
  test("failed saves retain the latest draft for an explicit retry", async () => {
    let fail = true
    const revisions: number[] = []
    const store = createDashboardAutosave({
      initial,
      delay: 10000,
      save: async (config, revision) => {
        revisions.push(revision)
        if (fail) throw new Error("Connection lost")
        return { ...initial, ...config, revision: revision + 1 }
      },
    })
    store.update((c) => ({ ...c, widgets: [widget] }))
    const failure = await store.flush().then(
      () => null,
      (error: Error) => error
    )
    expect(failure?.message).toBe("Connection lost")
    store.update((c) => ({ ...c, name: "Retained" }))
    expect(store.getSnapshot().status).toBe("error")
    expect(store.pending()).toBe(true)
    fail = false
    await store.flush()
    expect(revisions).toEqual([1, 1])
    expect(store.getSnapshot().saved.name).toBe("Retained")
    expect(store.getSnapshot().saved.widgets).toEqual([widget])
  })
})
