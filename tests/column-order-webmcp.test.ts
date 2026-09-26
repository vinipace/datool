import { describe, expect, test } from "bun:test"
import { createComputedColumnStore } from "../src/lib/tracer/computed-column-store"
import { createColumnTools } from "../src/lib/tracer/column-webmcp"
import { createColumnOrderStore } from "../src/lib/tracer/log-column-order"
import { getEvalTableColumns } from "../src/lib/tracer/eval-table-columns"

function fixture() {
  const data = new Map<string, string>()
  let fail = false
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("Quota exceeded")
      data.set(key, value)
    },
  }
  const store = createComputedColumnStore("run-1", () => storage)
  const order = createColumnOrderStore("order:run-1", () => storage)
  store.load()
  order.load()
  const tools = createColumnTools(store, {
    order,
    getColumns: () => getEvalTableColumns([["factuality", "Factuality"]], store.getSnapshot().columns),
  })
  const call = (name: string, args: object, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute({runId: "run-1", ...args}, {signal})
  return { call, order, store, storage, data, failWrites: () => { fail = true } }
}

describe("column order WebMCP", () => {
  test("lists built-in IDs and names and exposes fixed controls separately", async () => {
    const {call} = fixture()
    const result = (await call("get_eval_column_order", {})).structuredContent!
    expect(result.order).toEqual(["name", "input", "output", "expected", "all-scores", "score:factuality", "duration", "errors"])
    expect(result.fixedLeading).toEqual(["__select"])
    expect(result.fixedTrailing).toEqual(["add-column"])
    expect((result.columns as {id: string; name: string}[]).find(column => column.id === "score:factuality"))
      .toEqual({id: "score:factuality", name: "Factuality"})
  })

  test("swaps, moves and restores order through shared state with reload persistence", async () => {
    const {call, order, storage} = fixture()
    const swapped = (await call("swap_eval_columns", {firstColumnId: "input", secondColumnId: "output"})).structuredContent!
    expect((swapped.order as string[]).slice(0, 3)).toEqual(["name", "output", "input"])
    expect(order.getSnapshot()).toEqual(swapped.order)
    const moved = (await call("move_eval_column", {columnId: "errors", beforeColumnId: "name"})).structuredContent!
    expect((moved.order as string[])[0]).toBe("errors")
    await call("move_eval_column", {columnId: "errors", afterColumnId: "duration"})
    const restored = (await call("reorder_eval_columns", {columnIds: swapped.previousOrder})).structuredContent!
    expect(restored.order).toEqual(swapped.previousOrder)
    const reloaded = createColumnOrderStore("order:run-1", () => storage)
    reloaded.load()
    expect(reloaded.getSnapshot()).toEqual(restored.order)
    order.set(["output", "name", "input"])
    expect(((await call("get_eval_column_order", {})).structuredContent!.order as string[]).slice(0,3)).toEqual(["output", "name", "input"])
  })

  test("new and deleted computed columns are reflected without recreating tools", async () => {
    const {call} = fixture()
    await call("create_eval_column", {id:"reasoning", name:"Reasoning", code:"row.results[0]?.reasoning", mode:"expression"})
    expect(((await call("move_eval_column", {columnId:"computed:reasoning", afterColumnId:"score:factuality"})).structuredContent!.order as string[]).slice(5,7)).toEqual(["score:factuality", "computed:reasoning"])
    await call("delete_eval_column", {id:"reasoning"})
    expect((await call("get_eval_column_order", {})).structuredContent!.order).not.toContain("computed:reasoning")
    expect((await call("move_eval_column", {columnId:"computed:reasoning", beforeColumnId:"input"})).isError).toBe(true)
  })

  test("rejects stale or invalid orders, unknown or pinned IDs, wrong runs, and cancellation", async () => {
    const {call, order} = fixture()
    const original = order.getSnapshot()
    for (const args of [
      {columnId:"input"},
      {columnId:"input", beforeColumnId:"name", afterColumnId:"output"},
      {columnId:"add-column", beforeColumnId:"name"},
      {columnId:"input", beforeColumnId:"__select"},
      {runId:"other", columnId:"input", beforeColumnId:"name"},
    ]) expect((await call("move_eval_column", args)).isError).toBe(true)
    for (const columnIds of [[], ["name", "name"], ["unknown"]]) {
      expect((await call("reorder_eval_columns", {columnIds})).isError).toBe(true)
    }
    expect((await call("swap_eval_columns", {firstColumnId:"input",secondColumnId:"unknown"})).isError).toBe(true)
    expect((await call("move_eval_column", {columnId:"input",beforeColumnId:"name"}, AbortSignal.abort())).isError).toBe(true)
    expect(order.getSnapshot()).toBe(original)
  })

  test("failed persistence and unreadable saved order leave state unchanged", async () => {
    const {call, order, data, failWrites} = fixture()
    const original = order.getSnapshot()
    failWrites()
    expect((await call("swap_eval_columns", {firstColumnId:"input", secondColumnId:"output"})).isError).toBe(true)
    expect(order.getSnapshot()).toBe(original)
    data.set("order:run-1", "corrupt")
    order.load()
    expect((await call("move_eval_column", {columnId:"input", beforeColumnId:"output"})).isError).toBe(true)
    expect(data.get("order:run-1")).toBe("corrupt")
  })
})
