import { describe, expect, test } from "bun:test"
import { createColumnOrderStore, resolveCollectionColumnOrder } from "../src/lib/tracer/collection-column-order"

describe("collection column order", () => {
  test("keeps selection first and the add button last in a reordered table", () => {
    expect(resolveCollectionColumnOrder(
      ["__select", "name", "input", "output", "add"],
      ["add", "output", "__select", "name", "input"],
      ["add"],
    )).toEqual(["__select", "output", "name", "input", "add"])
  })

  test("drops removed and duplicate IDs and inserts new columns before actions", () => {
    expect(resolveCollectionColumnOrder(
      ["__select", "name", "input", "new-score", "computed:new", "add"],
      ["computed:deleted", "input", "input", "name"],
      ["add"],
    )).toEqual(["__select", "input", "name", "new-score", "computed:new", "add"])
  })

  test("visible reordered columns map to the original row cells", () => {
    const source = ["__select", "name", "input", "output", "cost", "add"]
    const cells = ["checkbox", "trace", "question", "answer", "R$5", ""]
    const order = resolveCollectionColumnOrder(source, ["cost", "output", "input", "name"], ["add"])
    const visible = order.filter(id => id !== "input")
    expect(visible.map(id => cells[source.indexOf(id)]))
      .toEqual(["checkbox", "R$5", "answer", "trace", ""])
    expect(order.indexOf("input")).toBe(3)
  })

  test("stores are isolated per table and notify subscribers of moves", () => {
    const first = createColumnOrderStore()
    const second = createColumnOrderStore()
    let notifications = 0
    const unsubscribe = first.subscribe(() => notifications++)
    first.set(["output", "input"])
    expect(first.getSnapshot()).toEqual(["output", "input"])
    expect(first.getServerSnapshot()).toEqual([])
    expect(second.getSnapshot()).toEqual([])
    expect(notifications).toBe(1)
    unsubscribe()
    first.set(["input", "output"])
    expect(notifications).toBe(1)
  })
})
