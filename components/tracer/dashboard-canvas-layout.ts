import {
  createGridLayout,
  findWidgetSpace,
} from "@/components/ui/canvas/layout"
import type { CanvasLayoutChange, CanvasWidget } from "@/components/ui/canvas"
import type { DashboardContentWidget } from "@/src/lib/tracer/dashboards"

export type DashboardWidgetProps = { widget: DashboardContentWidget }
export type DashboardWidgetMap = {
  [K in DashboardContentWidget["type"]]: DashboardWidgetProps
}

/** Old width-only JSON is projected without requiring a database migration. */
export function dashboardCanvasWidgets(
  widgets: DashboardContentWidget[]
): CanvasWidget<DashboardWidgetMap>[] {
  const placed: CanvasWidget<DashboardWidgetMap>[] = widgets
    .filter((widget) => widget.layout)
    .map((widget) => ({
      id: widget.id,
      type: widget.type,
      props: { widget },
      layout: widget.layout!,
    }))
  for (const widget of widgets) {
    if (widget.layout) continue
    const size = { w: widget.width * 4, h: 5 }
    placed.push({
      id: widget.id,
      type: widget.type,
      props: { widget },
      layout: findWidgetSpace(placed, size),
    })
  }
  const byId = new Map(
    createGridLayout(placed, 12).map((item) => [item.i, item])
  )
  return widgets.map((widget) => {
    const { x, y, w, h } = byId.get(widget.id)!
    return {
      id: widget.id,
      type: widget.type,
      props: { widget },
      layout: { x, y, w, h, minW: 2, minH: 2, maxH: 100 },
    }
  })
}

export function applyDashboardLayout(
  widgets: DashboardContentWidget[],
  changes: CanvasLayoutChange[]
): DashboardContentWidget[] {
  const layouts = new Map(changes.map(({ id, layout }) => [id, layout]))
  return widgets.map((widget) => {
    const layout = layouts.get(widget.id)
    if (!layout) return widget
    const { x, y, w, h } = layout
    return {
      ...widget,
      width: Math.min(3, Math.ceil(w / 4)) as 1 | 2 | 3,
      layout: { x, y, w, h },
    }
  })
}

export function appendDashboardWidget(
  widgets: DashboardContentWidget[],
  widget: DashboardContentWidget
): DashboardContentWidget[] {
  const current = dashboardCanvasWidgets(widgets)
  const layout = findWidgetSpace(current, {
    w: 4,
    h: widget.type === "metric" ? 3 : 5,
  })
  return [
    ...applyDashboardLayout(
      widgets,
      current.map(({ id, layout }) => ({ id, layout }))
    ),
    { ...widget, layout },
  ]
}
