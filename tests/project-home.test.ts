import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { eq, sql } from "drizzle-orm"
import { dashboardTemplates } from "@/src/lib/tracer/dashboard-templates"
import { createDashboardService } from "@/src/server/tracer/dashboards"
import { createProjectHomeService } from "@/src/server/tracer/project-home"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import {
  getTracerProjectId,
  registerTracerProjectId,
} from "@/src/server/tracer/db"
import { dashboards } from "@/src/server/tracer/schema"
import { routeScopes } from "@/src/server/auth/request"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import { closeTracerDatabase } from "@/src/server/tracer/db"

const template = () =>
  dashboardTemplates
    .find((entry) => entry.id === "customer-experience")!
    .create()

test("Home pins persist as live references and tolerate removed or unsupported sources", async () => {
  const db = await createTracerFixture()
  const reopened = reopenTracerFixture(db)
  try {
    const source = createDashboardService(db)
    const home = createProjectHomeService(db)
    expect(await run(home.get())).toEqual({
      revision: 0,
      pins: [],
      widgets: [],
    })
    const input = template()
    const dashboard = await run(source.create(input))
    const pinned = await run(
      home.pin({ dashboardId: dashboard.id, widgetId: "messages" })
    )
    const pinId = pinned.pins[0].id
    assert(pinned.widgets[0].type !== "text")
    expect(pinned.widgets[0].query.measures).toEqual([
      "buildEvents.messageCount",
    ])
    expect(pinned.widgets[0].id).toBe(pinId)
    expect(await run(createProjectHomeService(reopened).get())).toEqual(pinned)
    const changed = await run(
      source.update(dashboard.id, {
        expectedRevision: 1,
        config: {
          ...input,
          name: "Renamed source",
          widgets: input.widgets.map((widget) =>
            widget.id === "messages"
              ? { ...widget, title: "Customer messages" }
              : widget
          ),
        },
      })
    )
    const linked = await run(home.get())
    expect(linked.widgets[0].title).toBe("Customer messages")
    expect(linked.pins[0].dashboardName).toBe("Renamed source")
    expect(linked.pins[0].layout).toEqual(pinned.pins[0].layout)
    await db
      .update(dashboards)
      .set({ configJson: "broken JSON" })
      .where(eq(dashboards.id, dashboard.id))
    const unsupported = await run(home.get())
    expect(unsupported.widgets).toHaveLength(0)
    expect(unsupported.pins[0].unavailable).toContain("source dashboard")
    await db
      .update(dashboards)
      .set({ configJson: JSON.stringify({ ...input, widgets: [] }) })
      .where(eq(dashboards.id, dashboard.id))
    expect((await run(home.get())).pins[0].unavailable).toContain(
      "widget was removed"
    )
    await run(source.delete(dashboard.id, changed.revision))
    expect((await run(home.get())).pins[0].unavailable).toContain(
      "dashboard was removed"
    )
    expect((await run(home.unpin(pinId))).pins).toEqual([])
    expect((await run(home.unpin(pinId))).pins).toEqual([])
  } finally {
    await closeTracerDatabase(reopened)
    await closeTracerFixture(db)
  }
})

test("Home serializes concurrent pins, protects layout revisions, and cannot link another project's widgets", async () => {
  const db = await createTracerFixture()
  const other = reopenTracerFixture(db)
  try {
    const projectId = getTracerProjectId(db)
    const otherProject = `${projectId}-other`
    await db.execute(sql`insert into project (id, organization_id, name, slug, created_at, updated_at)
      select ${otherProject}, organization_id, 'Other', ${otherProject}, now(), now() from project where id=${projectId}`)
    registerTracerProjectId(other, otherProject)
    const source = createDashboardService(db)
    const home = createProjectHomeService(db)
    const otherHome = createProjectHomeService(other)
    const dashboard = await run(source.create(template()))
    await assert.rejects(
      run(otherHome.pin({ dashboardId: dashboard.id, widgetId: "messages" })),
      /not found/
    )
    await Promise.all(
      ["messages", "conversations", "messages", "contacts"].map((widgetId) =>
        run(home.pin({ dashboardId: dashboard.id, widgetId }))
      )
    )
    const initial = await run(home.get())
    expect(initial.pins).toHaveLength(3)
    expect(initial.revision).toBe(3)
    const layout = initial.pins.map((pin, index) => ({
      id: pin.id,
      layout: { x: 0, y: index * 4, w: 12, h: 4 },
    }))
    const arranged = await run(
      home.layout({ expectedRevision: initial.revision, layout })
    )
    expect(arranged.pins.map((pin) => pin.layout)).toEqual(
      layout.map((entry) => entry.layout)
    )
    await assert.rejects(
      run(home.layout({ expectedRevision: initial.revision, layout })),
      /Home changed/
    )
    await assert.rejects(
      run(
        home.layout({
          expectedRevision: arranged.revision,
          layout: layout.slice(1),
        })
      ),
      /every pinned widget/
    )
    await assert.rejects(
      run(
        home.layout({
          expectedRevision: arranged.revision,
          layout: layout.map((entry) => ({
            ...entry,
            layout: { x: 0, y: 0, w: 4, h: 3 },
          })),
        })
      ),
      /overlap/
    )
    await run(otherHome.unpin(initial.pins[0].id))
    expect((await run(home.get())).pins).toHaveLength(3)
    expect((await run(otherHome.get())).pins).toHaveLength(0)
    await run(home.unpin(initial.pins[0].id))
    expect((await run(source.get(dashboard.id))).widgets).toEqual(dashboard.widgets)
    expect((await run(source.get(dashboard.id))).revision).toBe(1)
    const second = await run(
      source.create({ ...template(), name: "Second source" })
    )
    for (const sourceId of [dashboard.id, second.id])
      for (const widget of template().widgets) {
        const current = await run(home.get())
        if (current.pins.length === 20) break
        await run(home.pin({ dashboardId: sourceId, widgetId: widget.id }))
      }
    const full = await run(home.get())
    expect(full.pins).toHaveLength(20)
    const existing = full.pins[0]
    expect(
      (
        await run(
          home.pin({
            dashboardId: existing.dashboardId,
            widgetId: existing.widgetId,
          })
        )
      ).revision
    ).toBe(full.revision)
    await assert.rejects(
      run(home.pin({ dashboardId: second.id, widgetId: "handoff-trend" })),
      /20 widgets/
    )
  } finally {
    await closeTracerDatabase(other)
    await closeTracerFixture(db)
  }
})

test("Home HTTP reads and mutations require the same permissions as dashboards", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"])
    expect(
      await routeScopes(
        new Request("https://datool.test/api/project-home", { method })
      )
    ).toEqual([method === "GET" ? "dashboards:read" : "dashboards:write"])
})

test("Home pins dashboard text widgets and follows edits to their source", async () => {
  const db = await createTracerFixture()
  try {
    const source = createDashboardService(db)
    const home = createProjectHomeService(db)
    const config = { ...template(), widgets: [{ id: "context", type: "text" as const, title: "Context", width: 3 as const, content: "# Support performance" }] }
    const dashboard = await run(source.create(config))
    const pinned = await run(home.pin({ dashboardId: dashboard.id, widgetId: "context" }))
    expect(pinned.widgets).toHaveLength(1)
    expect(pinned.widgets[0]).toMatchObject({ type: "text", content: "# Support performance" })
    await run(source.update(dashboard.id, {
      expectedRevision: dashboard.revision,
      config: { ...config, widgets: [{ ...config.widgets[0], content: "Updated reporting context" }] },
    }))
    expect((await run(home.get())).widgets[0]).toMatchObject({ id: pinned.pins[0].id, content: "Updated reporting context" })
  } finally {
    await closeTracerFixture(db)
  }
})
