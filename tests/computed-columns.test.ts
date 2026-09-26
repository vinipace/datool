import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import {
  columnExpression,
  columnRow,
  parseComputedColumns,
  type ComputedCell,
  type ComputedColumn,
  type EvalTableRow,
} from "../src/lib/tracer/computed-columns"
import { columnWorkerSource } from "../src/lib/tracer/column-worker-source"
import { GET } from "../app/api/eval-column-worker/route"
import type { DatasetItem } from "../src/lib/tracer/contracts"
import { performanceTableRow } from "../src/lib/tracer/performance-table"

const row: EvalTableRow = {
  id: "target",
  datasetItemId: null,
  expectedOutput: "Sunny",
  results: [],
  trace: {
    id: "trace",
    name: "Weather",
    operation: "weather",
    attributes: { metrics: { costUsd: 0.00398075, totalTokens: 1387 } },
    durationMs: 100,
    endedAt: null,
    startedAt: "2026-09-07",
    status: "completed",
    input: "Weather?",
    output: "Sunny",
    sessionId: null,
  },
}
function column(
  code: string,
  mode: ComputedColumn["mode"] = "expression"
): ComputedColumn {
  return { id: "cost", name: "Cost", code, mode }
}
async function evaluate(
  code: string,
  mode: ComputedColumn["mode"] = "expression",
  data: unknown = columnRow(row)
) {
  const replies: ComputedCell[] = []
  const self = {
    postMessage: (message: ComputedCell) => replies.push(message),
    onmessage: null as unknown as (event: unknown) => Promise<void>,
  }
  const context = createContext({ self })
  runInContext(columnWorkerSource, context)
  await self.onmessage({
    data: {
      expression: columnExpression(column(code, mode)),
      row: structuredClone(data),
    },
  })
  return replies.at(-1)!
}

describe("computed eval columns", () => {
  test("evaluates group metrics in the existing worker without fabricating a trace", async () => {
    for (const model of ["agents", "workflows"] as const) {
      const group = performanceTableRow({
        [`${model}.name`]: "Research",
        [`${model}.count`]: 10,
        [`${model}.versionCount`]: 3,
        [`${model}.completedCount`]: 8,
        [`${model}.reportedCostUsd`]: null,
      }, model)
      const data = columnRow(group)
      expect(data).toBe(group)
      expect(await evaluate("row.metrics.versionCount", "expression", data))
        .toEqual({ value: "3" })
      expect("trace" in data).toBe(false)
      expect(await evaluate("{{row.name}}: {{row.metrics.completedCount / row.metrics.count * 100}}%", "template", data))
        .toEqual({ value: "Research: 80%" })
      expect(await evaluate("row.metrics.reportedCostUsd === null ? 'Unavailable' : row.metrics.reportedCostUsd", "expression", data))
        .toEqual({ value: "Unavailable" })
    }
  })
  test("evaluates dataset fields without changing the original item", async () => {
    const item: DatasetItem = {
      id: "item", datasetId: "dataset", input: { question: "Where?" },
      expectedOutput: { answer: "Here." }, metadata: { locale: "en", reviewed: false },
      sourceTraceId: null, createdAt: "2026-09-11", updatedAt: "2026-09-11",
    }
    const original = structuredClone(item)
    expect(await evaluate("{{row.input.question}} {{row.expectedOutput.answer}} ({{row.metadata.locale}})", "template", columnRow(item)))
      .toEqual({ value: "Where? Here. (en)" })
    expect(await evaluate("row.metadata.reviewed", "expression", columnRow(item))).toEqual({ value: "false" })
    await evaluate("(row.input.question = 'Changed')", "expression", columnRow(item))
    expect(item).toEqual(original)
  })
  test("supports the requested currency template with actual trace cost", async () => {
    expect(await evaluate("R${{row.metrics.cost*5.5}}", "template")).toEqual({
      value: "R$0.021894125",
    })
    expect(
      await evaluate("R${{(row.metrics.cost*5.5).toFixed(4)}}", "template")
    ).toEqual({ value: "R$0.0219" })
  })
  test("supports JavaScript, multiple interpolations and literal quoting", async () => {
    expect(await evaluate("row.metrics.totalTokens + 1")).toEqual({
      value: "1388",
    })
    expect(await evaluate("`R$${row.metrics.cost * 5.5}`")).toEqual({
      value: "R$0.021894125",
    })
    expect(
      await evaluate('"{{row.input}}" → {{row.output}}', "template")
    ).toEqual({ value: '"Weather?" → Sunny' })
    expect(
      await evaluate(
        "({ expected: row.expectedOutput, matches: row.output === row.expectedOutput })"
      )
    ).toEqual({ value: '{"expected":"Sunny","matches":true}' })
  })
  test("keeps missing cost unavailable and preserves zero", () => {
    const without = { ...row, trace: { ...row.trace, attributes: {} } }
    expect(columnRow(without).metrics.cost).toBeUndefined()
    expect(
      columnRow({
        ...row,
        trace: { ...row.trace, attributes: { "cost.usd": 0 } },
      }).metrics.cost
    ).toBe(0)
  })
  test("renders null, false and zero without losing values", async () => {
    expect(await evaluate("null")).toEqual({ value: null })
    expect(await evaluate("false")).toEqual({ value: "false" })
    expect(await evaluate("0")).toEqual({ value: "0" })
  })
  test("reports invalid code and runtime failures as cell errors", async () => {
    expect((await evaluate("row.")).error).toBeTruthy()
    expect((await evaluate("row.missing.value")).error).toBeTruthy()
    expect((await evaluate("NaN")).error).toContain("non-finite")
    expect((await evaluate("'x'.repeat(16001)")).error).toContain("16,000")
    expect(() =>
      columnExpression(column("R${{row.metrics.cost", "template"))
    ).toThrow("Close each")
  })
  test("validates persisted columns and removes duplicate ids", () => {
    const valid = column("row.metrics.cost")
    expect(
      parseComputedColumns(JSON.stringify([valid, { id: "invalid" }, valid]))
    ).toEqual([valid])
    expect(parseComputedColumns(null)).toEqual([])
    expect(() => parseComputedColumns("{}")).toThrow()
  })
  test("serves workers with network and additional workers blocked", async () => {
    const response = GET()
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'none'; worker-src 'none'"
    )
    expect(response.headers.get("Content-Type")).toContain("text/javascript")
    expect(await response.text()).toBe(columnWorkerSource)
  })
})
