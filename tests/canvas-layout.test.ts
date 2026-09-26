import { describe, expect, test } from "bun:test"
import {
  createGridLayout,
  findWidgetSpace,
  hasLayoutChanges,
  keyboardLayout,
  layoutChanges,
  normalizeLayout,
  stackGridLayout,
} from "@/components/ui/canvas/layout"

const widgets = [
  { id: "a", layout: { x: 0, y: 0, w: 4, h: 3, minW: 3, maxW: 8 } },
  { id: "b", layout: { x: 4, y: 0, w: 4, h: 3 } },
  { id: "c", layout: { x: 0, y: 3, w: 8, h: 4 } },
]

function expectNoOverlap(layout: ReturnType<typeof createGridLayout>) {
  for (const a of layout)
    for (const b of layout) {
      if (a.i === b.i) continue
      expect(
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
      ).toBe(false)
    }
}

describe("canvas JSON layout contract", () => {
  test("fills a free slot and compacts cards after removal without mutating input", () => {
    const before = structuredClone(widgets)
    expect(findWidgetSpace(widgets, { w: 4, h: 3 })).toEqual({
      x: 8,
      y: 0,
      w: 4,
      h: 3,
    })
    const remaining = createGridLayout(
      widgets.filter((widget) => widget.id === "c")
    )
    expect(remaining[0].y).toBe(0)
    expect(widgets).toEqual(before)
  })

  test("colliding additions and restored JSON reflow without overlaps", () => {
    const additions = [
      ...widgets,
      { id: "d", layout: { x: 0, y: 0, w: 6, h: 4 } },
    ]
    const next = createGridLayout(additions)
    expect(next).toHaveLength(4)
    expectNoOverlap(next)
    const changes = layoutChanges(additions, next)
    const restored = JSON.parse(JSON.stringify(changes))
    expect(createGridLayout(restored)).toEqual(next)
    expect(changes[0].layout).toMatchObject({ minW: 3, maxW: 8 })
    expect(Object.hasOwn(changes[0].layout, "i")).toBe(false)
    expect(Object.hasOwn(changes[0].layout, "moved")).toBe(false)
  })

  test("narrow preview preserves saved coordinates and constraints", () => {
    const original = createGridLayout(widgets)
    const before = structuredClone(original)
    const stacked = stackGridLayout(original, 12)
    expect(stacked.every((item) => item.x === 0 && item.w === 12)).toBe(true)
    expectNoOverlap(stacked)
    expect(original).toEqual(before)
    expect(hasLayoutChanges(widgets, layoutChanges(widgets, original))).toBe(
      false
    )
  })

  test("keyboard moves and resizes resolve collisions and obey size limits", () => {
    const original = createGridLayout(widgets)
    const resized = keyboardLayout(original, "a", 50, 0, true, 12)
    expect(resized.find((item) => item.i === "a")?.w).toBe(8)
    expectNoOverlap(resized)
    const moved = keyboardLayout(original, "a", 4, 0, false, 12)
    expect(moved.find((item) => item.i === "a")?.x).toBe(4)
    expectNoOverlap(moved)
    expect(original.find((item) => item.i === "a")?.w).toBe(4)
  })

  test("invalid numbers and out-of-bounds sizes are normalized", () => {
    expect(
      normalizeLayout(
        { x: 40, y: -4, w: Infinity, h: NaN, minW: 20, minH: 3, maxW: 2 },
        12
      )
    ).toMatchObject({ x: 0, y: 0, w: 12, h: 3, minW: 12, maxW: 12 })
  })
})
