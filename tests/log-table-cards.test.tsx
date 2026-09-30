import { describe, expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  LogRow,
  LogRowSelection,
  LogSelectAll,
  LogTable,
  LogTableBody,
} from "@/components/tracer/log-table"
import { createColumnOrderStore } from "@/src/lib/tracer/log-column-order"

function Example({
  view = "table",
  hideB = false,
}: {
  view?: "table" | "cards"
  hideB?: boolean
}) {
  const store = createColumnOrderStore()
  store.set(["c", "a", "b"])
  return (
    <LogTable
      enableCardView
      defaultView={view}
      settings={
        hideB
          ? { view, columnVisibility: { b: false }, columnSizing: {} }
          : undefined
      }
      displayControls={false}
      reorderable
      columnOrderStore={{ ...store, getServerSnapshot: store.getSnapshot }}
      columnIds={["a", "b", "c", "add"]}
      widths={[200, 200, 200, 100]}
      actionColumnIds={["add"]}
    >
      <caption className="sr-only">
        Example rows. Open a row to inspect it.
      </caption>
      <thead>
        <tr>
          <th>
            <LogSelectAll
              checked={false}
              partial
              disabled={false}
              label="Select all examples"
              onChange={() => {}}
            />
          </th>
          <th>A</th>
          <th>B</th>
          <th aria-label="C">
            <button>Edit C</button>
          </th>
          <th>
            <button>Add column</button>
          </th>
        </tr>
      </thead>
      <LogRow checked tabIndex={0} aria-label="Open example">
        <LogRowSelection
          index={0}
          checked
          label="Select example"
          onChange={() => {}}
        />
        <td>
          <strong>foo</strong>
        </td>
        <td>bar</td>
        <td>
          <span>doe</span>
        </td>
        <td />
      </LogRow>
    </LogTable>
  )
}

describe("log table card view", () => {
  test("pairs existing headers and rich cells in saved order, retaining selection and actions", () => {
    const markup = renderToStaticMarkup(<Example view="cards" />)
    const fields = [
      ...markup.matchAll(/<dt\b[^>]*>(.*?)<\/dt><dd\b[^>]*>(.*?)<\/dd>/g),
    ].map(([, header, value]) => [header, value])
    expect(fields).toEqual([
      ["<button>Edit C</button>", "<span>doe</span>"],
      ["A", "<strong>foo</strong>"],
      ["B", "bar"],
    ])
    expect(
      /<article\b[^>]*aria-label="Open example"[^>]*data-selected="true"/.test(
        markup
      )
    ).toBe(true)
    expect(
      /<input\b[^>]*aria-label="Select example"[^>]*checked=""/.test(markup)
    ).toBe(true)
    expect(markup.match(/Add column/g)).toHaveLength(1)
    expect(markup).toContain(
      '<div class="sr-only">Example rows. Open a row to inspect it.</div>'
    )
    expect(/<(table|caption|thead|tbody|tr|td|th)\b/.test(markup)).toBe(false)
  })

  test("default table keeps visible headers aligned with their reordered cells", () => {
    for (const hideB of [false, true]) {
      const markup = renderToStaticMarkup(<Example hideB={hideB} />)
      const headers = [...markup.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(
        ([, content]) => content.replace(/<[^>]*>/g, "")
      )
      const cells = [...markup.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map(
        ([, content]) => content.replace(/<[^>]*>/g, "")
      )
      expect(headers).toEqual(
        hideB
          ? ["", "Edit C", "A", "Add column"]
          : ["", "Edit C", "A", "B", "Add column"]
      )
      expect(cells).toEqual(
        hideB ? ["1", "doe", "foo", ""] : ["1", "doe", "foo", "bar", ""]
      )
      expect(markup).toContain("<table")
      expect(markup).toContain(
        '<caption class="sr-only">Example rows. Open a row to inspect it.</caption>'
      )
      expect(markup).toContain("<strong>foo</strong>")
      expect(markup).not.toContain("<article")
      expect(markup).not.toContain("<dl")
    }
  })

  test("reuses table empty messages without invalid table elements in card mode", () => {
    const markup = renderToStaticMarkup(
      <LogTable widths={[200]} defaultView="cards" displayControls={false}>
        <thead>
          <tr>
            <th />
            <th>Name</th>
          </tr>
        </thead>
        <LogTableBody
          rows={[]}
          empty={
            <tr>
              <td colSpan={2}>No matching rows.</td>
            </tr>
          }
        >
          {() => <LogRow />}
        </LogTableBody>
      </LogTable>
    )
    expect(markup).toContain("No matching rows.")
    expect(markup).not.toContain("Select all")
    expect(/<(table|caption|thead|tbody|tr|td|th)\b/.test(markup)).toBe(false)
  })

  test("numbered collections do not advertise selection without a checkbox", () => {
    const markup = renderToStaticMarkup(
      <LogTable widths={[200]} defaultView="cards">
        <thead>
          <tr>
            <th>No.</th>
            <th>Name</th>
          </tr>
        </thead>
        <LogRow>
          <td>1</td>
          <td>Review session</td>
        </LogRow>
      </LogTable>
    )
    expect(markup).toContain("Review session")
    expect(markup).not.toContain("Select all")
  })
})
