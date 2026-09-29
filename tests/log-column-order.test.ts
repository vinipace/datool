import { describe, expect, test } from "bun:test"
import {
  createColumnOrderStore,
  resolveLogColumnOrder,
} from "../src/lib/tracer/log-column-order"

describe("log column order", () => {
  test("keeps selection first and the add button last in a reordered table", () => {
    expect(
      resolveLogColumnOrder(
        ["__select", "name", "input", "output", "add"],
        ["add", "output", "__select", "name", "input"],
        ["add"]
      )
    ).toEqual(["__select", "output", "name", "input", "add"])
  })

  test("drops removed and duplicate IDs and inserts new columns before actions", () => {
    expect(
      resolveLogColumnOrder(
        ["__select", "name", "input", "new-score", "computed:new", "add"],
        ["computed:deleted", "input", "input", "name"],
        ["add"]
      )
    ).toEqual(["__select", "input", "name", "new-score", "computed:new", "add"])
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
