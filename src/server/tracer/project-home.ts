import { and, eq, inArray } from "drizzle-orm"
import { dashboardContentWidgetSchema } from "@/src/lib/tracer/dashboards"
import { dashboardCohorts } from "@/src/lib/tracer/dashboard-filters"
import {
  HOME_WIDGET_LIMIT,
  homePinsSchema,
  homeLayoutSchema,
  pinHomeWidgetSchema,
  type HomePin,
  type ProjectHome,
} from "@/src/lib/tracer/project-home"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { validateSemanticQuery } from "@/src/server/semantic/executor"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { dashboards, projectHome } from "./schema"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"

function sourceWidget(row: typeof dashboards.$inferSelect, widgetId: string) {
  try {
    const config = JSON.parse(row.configJson)
    const raw = Array.isArray(config.widgets)
      ? config.widgets.find(
          (widget: { id?: string }) => widget?.id === widgetId
        )
      : undefined
    if (!raw) return { error: "This widget was removed from its dashboard." }
    const parsed = dashboardContentWidgetSchema.safeParse(raw)
    if (!parsed.success)
      return { error: "Update this widget in its source dashboard." }
    if (parsed.data.type !== "text") {
      for (const cohort of dashboardCohorts(parsed.data))
        validateSemanticQuery(cohort.query, semanticCatalog)
    }
    return { widget: parsed.data }
  } catch {
    return { error: "Update this widget in its source dashboard." }
  }
}

export function createProjectHomeService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const get = async (): Promise<ProjectHome> => {
    const [home] = await database
      .select()
      .from(projectHome)
      .where(eq(projectHome.projectId, projectId))
    if (!home) return { revision: 0, pins: [], widgets: [] }
    const pins = homePinsSchema.parse(JSON.parse(home.pinsJson))
    const sources = pins.length
      ? await database
          .select()
          .from(dashboards)
          .where(
            and(
              eq(dashboards.projectId, projectId),
              inArray(
                dashboards.id,
                pins.map((pin) => pin.dashboardId)
              )
            )
          )
      : []
    const widgets: ProjectHome["widgets"] = []
    return {
      revision: home.revision,
      pins: pins.map((pin) => {
        const row = sources.find((source) => source.id === pin.dashboardId)
        if (!row)
          return { ...pin, unavailable: "The source dashboard was removed." }
        const source = sourceWidget(row, pin.widgetId)
        if (!source.widget)
          return { ...pin, dashboardName: row.name, unavailable: source.error }
        widgets.push({ ...source.widget, id: pin.id, layout: pin.layout })
        return { ...pin, title: source.widget.title, dashboardName: row.name }
      }),
      widgets,
    }
  }
  type Tx = Parameters<Parameters<TracerDatabase["transaction"]>[0]>[0]
  const mutate = async (
    change: (pins: HomePin[], revision: number, tx: Tx) => Promise<HomePin[]>
  ) => {
    await database.transaction(async (tx) => {
      await tx.insert(projectHome).values({ projectId }).onConflictDoNothing()
      const [row] = await tx
        .select()
        .from(projectHome)
        .where(eq(projectHome.projectId, projectId))
        .for("update")
      const pins = homePinsSchema.parse(JSON.parse(row.pinsJson))
      const next = await change(pins, row.revision, tx)
      if (JSON.stringify(pins) === JSON.stringify(next)) return
      await tx
        .update(projectHome)
        .set({
          pinsJson: JSON.stringify(homePinsSchema.parse(next)),
          revision: row.revision + 1,
        })
        .where(eq(projectHome.projectId, projectId))
    })
    return get()
  }
  return {
    get: () => tracerEffect(get),
    pin: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = pinHomeWidgetSchema.safeParse(value)
        if (!parsed.success)
          throw validation("Choose a dashboard and widget to pin.")
        const input = parsed.data
        return mutate(async (pins, _revision, tx) => {
          if (
            pins.some(
              (pin) =>
                pin.dashboardId === input.dashboardId &&
                pin.widgetId === input.widgetId
            )
          )
            return pins
          if (pins.length >= HOME_WIDGET_LIMIT)
            throw validation(
              `Home can hold up to ${HOME_WIDGET_LIMIT} widgets. Unpin a widget first.`
            )
          const [row] = await tx
            .select()
            .from(dashboards)
            .where(
              and(
                eq(dashboards.projectId, projectId),
                eq(dashboards.id, input.dashboardId)
              )
            )
          if (!row) throw notFound("Dashboard", input.dashboardId)
          const source = sourceWidget(row, input.widgetId)
          if (!source.widget)
            throw validation(source.error ?? "Widget unavailable.")
          const { widget } = source
          const size = {
            w: widget.layout?.w ?? widget.width * 4,
            h: widget.layout?.h ?? (widget.type === "metric" ? 3 : 5),
          }
          // Fill the first available space without changing existing placements.
          let layout = {
            x: 0,
            y: Math.max(0, ...pins.map((pin) => pin.layout.y + pin.layout.h)),
            ...size,
          }
          outer: for (let y = 0; y <= layout.y; y++)
            for (let x = 0; x + size.w <= 12; x++) {
              if (
                pins.every(
                  ({ layout: other }) =>
                    x + size.w <= other.x ||
                    x >= other.x + other.w ||
                    y + size.h <= other.y ||
                    y >= other.y + other.h
                )
              ) {
                layout = { x, y, ...size }
                break outer
              }
            }
          return [
            ...pins,
            {
              ...input,
              id: `pin_${crypto.randomUUID()}`,
              title: widget.title,
              dashboardName: row.name,
              layout,
            },
          ]
        })
      }),
    unpin: (id: string) =>
      tracerEffect(() =>
        mutate(async (pins) => pins.filter((pin) => pin.id !== id))
      ),
    layout: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = homeLayoutSchema.safeParse(value)
        if (!parsed.success)
          throw validation("A valid layout and expectedRevision are required.")
        const input = parsed.data
        return mutate(async (pins, revision) => {
          if (input.expectedRevision !== revision)
            throw new TracerError(
              "CONFLICT",
              "Home changed while you were arranging it. Reload Home before saving again."
            )
          const layouts = new Map(
            input.layout.map((entry) => [entry.id, entry.layout])
          )
          if (
            layouts.size !== input.layout.length ||
            layouts.size !== pins.length ||
            pins.some((pin) => !layouts.has(pin.id))
          )
            throw validation(
              "The layout must include every pinned widget exactly once."
            )
          for (const [index, { layout: a }] of input.layout.entries())
            if (
              input.layout
                .slice(index + 1)
                .some(
                  ({ layout: b }) =>
                    a.x < b.x + b.w &&
                    b.x < a.x + a.w &&
                    a.y < b.y + b.h &&
                    b.y < a.y + a.h
                )
            )
              throw validation("Pinned widgets must not overlap.")
          return pins.map((pin) => ({ ...pin, layout: layouts.get(pin.id)! }))
        })
      }),
  }
}
