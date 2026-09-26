import type { ComputedColumn } from "./computed-columns"

/** Shared catalog for the table and its WebMCP ordering tools. */
export function getEvalTableColumns(scorers: [string, string][], computed: ComputedColumn[]) {
  return [
    { id: "name", name: "Name", width: 220 },
    { id: "input", name: "Input", width: 240 },
    { id: "output", name: "Output", width: 240 },
    { id: "expected", name: "Expected", width: 240 },
    { id: "all-scores", name: "All Scores", width: 160 },
    ...scorers.map(([id, name]) => ({ id: `score:${id}`, name, width: 160 })),
    { id: "duration", name: "Duration", width: 120 },
    { id: "errors", name: "Errors", width: 240 },
    ...computed.map(column => ({ id: `computed:${column.id}`, name: column.name, width: 200 })),
  ]
}
