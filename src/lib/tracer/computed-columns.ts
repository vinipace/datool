import type { DatasetItem, EvalRunDetail } from "./contracts"
import type { PerformanceTableRow } from "./performance-table"

export type EvalTableRow = NonNullable<EvalRunDetail["rows"]>[number]
export type ComputedRow = EvalTableRow | DatasetItem | PerformanceTableRow
export type ComputedResource = "eval" | "dataset" | "performance"
export type ComputedColumn = {
  id: string
  name: string
  code: string
  format?: "text" | "markdown"
  mode: "expression" | "template"
}
export type ComputedCell = { value: string | null; error?: string }

function evalColumnRow(row: EvalTableRow) {
  const source = row.trace.attributes.metrics
  const metrics =
    source && typeof source === "object" && !Array.isArray(source) ? source : {}
  const cost = metrics.costUsd ?? row.trace.attributes["cost.usd"]
  return {
    ...row.trace,
    ...row,
    input: row.trace.input,
    output: row.trace.output,
    metrics: {
      ...metrics,
      cost: typeof cost === "number" ? cost : undefined,
      durationMs: row.trace.durationMs,
    },
  }
}

export function columnRow(row: EvalTableRow): ReturnType<typeof evalColumnRow>
export function columnRow(row: DatasetItem): DatasetItem
export function columnRow(row: PerformanceTableRow): PerformanceTableRow
export function columnRow(row: ComputedRow): ReturnType<typeof evalColumnRow> | DatasetItem | PerformanceTableRow
export function columnRow(row: ComputedRow) {
  return "trace" in row ? evalColumnRow(row) : row
}

export function columnExpression(
  column: Pick<ComputedColumn, "code" | "mode">
) {
  if (column.mode === "expression") return column.code
  const parts: string[] = []
  let end = 0
  for (const match of column.code.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    parts.push(JSON.stringify(column.code.slice(end, match.index)))
    parts.push(`String((${match[1]}) ?? "")`)
    end = match.index + match[0].length
  }
  if (column.code.slice(end).includes("{{"))
    throw new Error("Close each template expression with }}")
  parts.push(JSON.stringify(column.code.slice(end)))
  return parts.join(" + ")
}

export function parseComputedColumns(raw: string | null): ComputedColumn[] {
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error("Invalid saved columns")
  const ids = new Set<string>()
  return parsed.filter((value): value is ComputedColumn => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      ids.has(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.code !== "string" ||
      !["expression", "template"].includes(value.mode)
    )
      return false
    ids.add(value.id)
    return true
  })
}

/** A separate worker keeps runaway expressions off the UI thread. Its response
 * CSP blocks network requests, imports and child workers. No server execution. */
export function evaluateColumn(
  rows: ComputedRow[],
  column: ComputedColumn,
  signal: AbortSignal
): Promise<Record<string, ComputedCell>> {
  return new Promise((resolve) => {
    const cells: Record<string, ComputedCell> = {}
    let expression: string
    try {
      expression = columnExpression(column)
    } catch (error) {
      resolve(
        Object.fromEntries(
          rows.map((row) => [row.id, { value: null, error: String(error) }])
        )
      )
      return
    }
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout>
    let index = 0
    const stop = () => {
      clearTimeout(timer)
      worker?.terminate()
    }
    const done = () => {
      stop()
      signal.removeEventListener("abort", done)
      resolve(cells)
    }
    const fail = (error: string) => {
      for (; index < rows.length; index++)
        cells[rows[index].id] = { value: null, error }
      done()
    }
    const send = () => {
      clearTimeout(timer)
      if (index >= rows.length || signal.aborted) {
        done()
        return
      }
      timer = setTimeout(() => {
        cells[rows[index++].id] = {
          value: null,
          error: "Expression exceeded 500 ms",
        }
        stop()
        start()
      }, 500)
      worker!.postMessage({ expression, row: columnRow(rows[index]) })
    }
    const start = () => {
      if (index >= rows.length || signal.aborted) {
        done()
        return
      }
      try {
        worker = new Worker("/api/eval-column-worker")
        timer = setTimeout(
          () => fail("Could not start the expression worker"),
          10000
        )
        worker.onmessage = (
          event: MessageEvent<ComputedCell | { ready: true }>
        ) => {
          if ("ready" in event.data) {
            send()
            return
          }
          cells[rows[index++].id] = event.data
          send()
        }
        worker.onerror = () => fail("Could not evaluate the column")
      } catch {
        fail("JavaScript workers are unavailable in this browser")
      }
    }
    signal.addEventListener("abort", done, { once: true })
    start()
  })
}
