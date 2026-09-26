import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "bun:test"
import { LogTable, LogRow } from "@/components/tracer/log-table"

test("saved visibility and presentation drive the existing table while action columns remain available", () => {
  const markup = renderToStaticMarkup(
    <LogTable
      settings={{
        view: "cards",
        columnVisibility: { output: false, name: false, add: false },
        columnSizing: { name: 320 },
      }}
      columnIds={["name", "output", "add"]}
      widths={[200, 200, 160]}
      actionColumnIds={["add"]}
      displayControls={false}
    >
      <thead>
        <tr>
          <th />
          <th>Name</th>
          <th>Output</th>
          <th>
            <button>Add column</button>
          </th>
        </tr>
      </thead>
      <LogRow>
        <td />
        <td>Sample target</td>
        <td>Hidden output payload</td>
        <td />
      </LogRow>
    </LogTable>
  )
  expect(markup).toContain("<article")
  expect(markup).toContain("Sample target")
  expect(markup).not.toContain("Hidden output payload")
  expect(markup.match(/Add column/g)).toHaveLength(1)
})
