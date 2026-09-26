import { expect, test } from "bun:test"
import { createComputedColumnStore } from "../src/lib/tracer/computed-column-store"
import { createColumnOrderStore } from "../src/lib/tracer/log-column-order"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

test("keeps eval column settings separate for projects with the same run ID", () => {
  const storage = memoryStorage()
  const runId = "preview-run"
  const projectA = "datool:eval-columns:acme:production:preview-run"
  const projectB = "datool:eval-columns:acme:staging:preview-run"
  const orderA = "datool:eval-column-order:acme:production:preview-run"
  const orderB = "datool:eval-column-order:acme:staging:preview-run"

  const computed = createComputedColumnStore(runId, () => storage, projectA)
  computed.update([
    {
      id: "cost",
      name: "Cost",
      code: "row.metrics.cost",
      mode: "expression",
    },
  ])
  const order = createColumnOrderStore(orderA, () => storage)
  order.set(["output", "computed:cost", "input"])

  const otherComputed = createComputedColumnStore(runId, () => storage, projectB)
  const otherOrder = createColumnOrderStore(orderB, () => storage)
  otherComputed.load()
  otherOrder.load()
  expect(otherComputed.getSnapshot().columns).toEqual([])
  expect(otherOrder.getSnapshot()).toEqual([])

  const reloadedComputed = createComputedColumnStore(runId, () => storage, projectA)
  const reloadedOrder = createColumnOrderStore(orderA, () => storage)
  reloadedComputed.load()
  reloadedOrder.load()
  expect(reloadedComputed.getSnapshot().columns).toHaveLength(1)
  expect(reloadedOrder.getSnapshot()).toEqual([
    "output",
    "computed:cost",
    "input",
  ])
})
