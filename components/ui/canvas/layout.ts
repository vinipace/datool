import {
  moveElement,
  verticalCompactor,
  type Layout,
  type LayoutItem,
} from "react-grid-layout"
import type { CanvasLayoutChange, WidgetLayout } from "./types"

type PositionedWidget = { id: string; layout: WidgetLayout }

function integer(
  value: number,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER
) {
  return Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? Math.round(value) : fallback)
  )
}

/** Clamp persisted coordinates before they reach the grid, without mutating input. */
export function normalizeLayout(
  layout: WidgetLayout,
  columns: number
): WidgetLayout {
  const minW = integer(layout.minW ?? 2, 2, 1, columns)
  const minH = integer(layout.minH ?? 2, 2, 1)
  const maxW = integer(layout.maxW ?? columns, columns, minW, columns)
  const maxH = integer(
    layout.maxH ?? Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    minH
  )
  const w = integer(layout.w, minW, minW, maxW)
  return {
    ...layout,
    x: integer(layout.x, 0, 0, columns - w),
    y: integer(layout.y, 0, 0),
    w,
    h: integer(layout.h, minH, minH, maxH),
    minW,
    minH,
    ...(layout.maxW === undefined ? {} : { maxW }),
    ...(layout.maxH === undefined ? {} : { maxH }),
  }
}

export function createGridLayout(
  widgets: readonly PositionedWidget[],
  columns = 12
): Layout {
  return verticalCompactor.compact(
    widgets.map(({ id, layout }) => ({
      ...normalizeLayout(layout, columns),
      i: id,
    })),
    columns
  )
}

/** A narrow preview must never overwrite the user's saved desktop arrangement. */
export function stackGridLayout(layout: Layout, columns: number): Layout {
  let y = 0
  return [...layout]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => {
      const stacked = { ...item, x: 0, y, w: columns, minW: 1, maxW: columns }
      y += item.h
      return stacked
    })
}

export function layoutChanges(
  widgets: readonly PositionedWidget[],
  layout: Layout
): CanvasLayoutChange[] {
  const byId = new Map(layout.map((item) => [item.i, item]))
  return widgets.map(({ id, layout: previous }) => {
    const next = byId.get(id)
    return {
      id,
      layout: next
        ? { ...previous, x: next.x, y: next.y, w: next.w, h: next.h }
        : previous,
    }
  })
}

export function hasLayoutChanges(
  widgets: readonly PositionedWidget[],
  changes: readonly CanvasLayoutChange[]
) {
  const previous = new Map(widgets.map((widget) => [widget.id, widget.layout]))
  return changes.some(({ id, layout }) => {
    const before = previous.get(id)
    return (
      !before ||
      (["x", "y", "w", "h"] as const).some((key) => before[key] !== layout[key])
    )
  })
}

/** Find the first free slot so adding a card uses available space. */
export function findWidgetSpace(
  widgets: readonly PositionedWidget[],
  size: Pick<WidgetLayout, "w" | "h">,
  columns = 12
): WidgetLayout {
  const layout = createGridLayout(widgets, columns)
  const { w, h } = normalizeLayout({ x: 0, y: 0, ...size }, columns)
  const bottom = Math.max(0, ...layout.map((item) => item.y + item.h))
  // Only occupied row boundaries can introduce a new free position.
  const rows = [...new Set([0, ...layout.map((item) => item.y + item.h)])].sort(
    (a, b) => a - b
  )
  for (const y of rows) {
    for (let x = 0; x <= columns - w; x++) {
      if (
        !layout.some(
          (item) =>
            x < item.x + item.w &&
            x + w > item.x &&
            y < item.y + item.h &&
            y + h > item.y
        )
      ) {
        return { x, y, w, h }
      }
    }
  }
  return { x: 0, y: bottom, w, h }
}

export function keyboardLayout(
  layout: Layout,
  id: string,
  dx: number,
  dy: number,
  resize: boolean,
  columns: number
): Layout {
  const next: LayoutItem[] = layout.map((item) => ({ ...item }))
  const item = next.find((entry) => entry.i === id)
  if (!item) return layout
  if (resize) {
    Object.assign(
      item,
      normalizeLayout(
        {
          ...item,
          w: item.w + dx,
          h: item.h + dy,
          maxW: Math.min(item.maxW ?? columns, columns - item.x),
        },
        columns
      )
    )
  } else {
    return verticalCompactor.compact(
      moveElement(
        next,
        item,
        Math.max(0, Math.min(columns - item.w, item.x + dx)),
        Math.max(0, item.y + dy),
        true,
        false,
        "vertical",
        columns
      ),
      columns
    )
  }
  return verticalCompactor.compact(next, columns)
}
