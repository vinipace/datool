import type { SemanticDataRow } from "@/src/lib/semantic/result"

/** Row summaries are independently aggregated by the server, never averaged cells. */
export function matrixRowSummaries(
  rows: SemanticDataRow[],
  rowFields: string[],
  measure: string
) {
  const values = new Map<string, SemanticDataRow[string]>()
  for (const row of rows) {
    const key = JSON.stringify(rowFields.map((field) => row[field]))
    if (values.has(key))
      throw new Error("Matrix row summaries contain duplicate rows.")
    values.set(key, row[measure])
  }
  return values
}

/** Pivot only. Never average aggregates or turn absent observations into zeros. */
export function dashboardMatrix(
  rows: SemanticDataRow[],
  dimensions: string[],
  measure: string,
  columnOrder?: "asc" | "desc"
) {
  const rowFields = dimensions.slice(0, -1)
  const columnField = dimensions.at(-1)!
  const rowKeys = new Map<string, SemanticDataRow>()
  const columns = new Map<string, SemanticDataRow[string]>()
  const cells = new Map<string, SemanticDataRow[string]>()
  for (const row of rows) {
    const key = JSON.stringify(rowFields.map((field) => row[field]))
    const column = JSON.stringify(row[columnField])
    rowKeys.set(key, row)
    columns.set(column, row[columnField])
    const cell = JSON.stringify([key, column])
    if (cells.has(cell))
      throw new Error(
        "Matrix results contain duplicate cells. Include all grouping fields in the matrix."
      )
    cells.set(cell, row[measure])
  }
  const orderedColumns = [...columns]
  if (columnOrder)
    orderedColumns.sort(([, a], [, b]) => {
      // Keep missing groups last, as in semantic SQL ordering.
      if (a == null) return b == null ? 0 : 1
      if (b == null) return -1
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b))
      return columnOrder === "desc" ? -comparison : comparison
    })
  return {
    rowFields,
    columnField,
    rows: [...rowKeys],
    columns: orderedColumns,
    cells,
  }
}

/** Compact presentation only: never remove dimensions from the actual query. */
export function matrixRowLabels(matrix: ReturnType<typeof dashboardMatrix>) {
  const shared = matrix.rowFields.filter((field) =>
    matrix.rows.every(([, row]) => row[field] === matrix.rows[0]?.[1][field])
  )
  let varying = matrix.rowFields.filter((field) => !shared.includes(field))
  // Hide opaque IDs only when the remaining labels still identify every row.
  for (const field of varying.filter((name) => name.endsWith("Id"))) {
    const remaining = varying.filter((name) => name !== field)
    if (
      remaining.length &&
      new Set(
        matrix.rows.map(([, row]) =>
          JSON.stringify(remaining.map((name) => row[name]))
        )
      ).size === matrix.rows.length
    )
      varying = remaining
  }
  return { shared, varying }
}

/** Scores use their fixed 0–1 scale, never a scale relative to the current page. */
export function matrixScoreValue(
  measure: string,
  value: unknown
): number | null {
  const [model, member] = measure.split(".")
  return ((model === "evalClassification" &&
    ["precision", "recall", "f1", "accuracy"].includes(member)) ||
    (["evalResults", "evalQuality", "scores"].includes(model) &&
      ["meanScore", "p50Score", "p95Score", "explicitPassRate"].includes(
        member
      ))) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null
}
