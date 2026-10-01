import { describe, expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CollectionRow, CollectionRowSelection, CollectionSelectAll, CollectionTable, CollectionTableBody } from "@/components/tracer/collection-table"
import { createColumnOrderStore } from "@/src/lib/tracer/collection-column-order"

function Example({ view = "table" }: { view?: "table" | "cards" }) {
  const store = createColumnOrderStore()
  store.set(["c", "a", "b"])
  return <CollectionTable enableCardView defaultView={view} displayControls={false} reorderable columnOrderStore={{ ...store, getServerSnapshot: store.getSnapshot }} columnIds={["a", "b", "c", "add"]} widths={[200, 200, 200, 100]} actionColumnIds={["add"]}>
    <caption className="sr-only">Example rows. Open a row to inspect it.</caption>
    <thead><tr>
      <th><CollectionSelectAll checked={false} partial disabled={false} label="Select all examples" onChange={() => {}} /></th>
      <th>A</th><th>B</th><th aria-label="C"><button>Edit C</button></th>
      <th><button>Add column</button></th>
    </tr></thead>
    <CollectionRow checked tabIndex={0} aria-label="Open example">
      <CollectionRowSelection index={0} checked label="Select example" onChange={() => {}} />
      <td><strong>foo</strong></td><td>bar</td><td><span>doe</span></td><td />
    </CollectionRow>
  </CollectionTable>
}

describe("collection table card view", () => {
  test("pairs existing headers and rich cells in saved order, retaining selection and actions", () => {
    const markup = renderToStaticMarkup(<Example view="cards" />)
    const fields = [...markup.matchAll(/<dt\b[^>]*>(.*?)<\/dt><dd\b[^>]*>(.*?)<\/dd>/g)].map(([, header, value]) => [header, value])
    expect(fields).toEqual([["<button>Edit C</button>", "<span>doe</span>"], ["A", "<strong>foo</strong>"], ["B", "bar"]])
    expect(/<article\b[^>]*aria-label="Open example"[^>]*data-selected="true"/.test(markup)).toBe(true)
    expect(/<input\b[^>]*aria-label="Select example"[^>]*checked=""/.test(markup)).toBe(true)
    expect(markup.match(/Add column/g)).toHaveLength(1)
    expect(markup).toContain('<div class="sr-only">Example rows. Open a row to inspect it.</div>')
    expect(/<(table|caption|thead|tbody|tr|td|th)\b/.test(markup)).toBe(false)
  })

  test("keeps the original table presentation by default", () => {
    const markup = renderToStaticMarkup(<Example />)
    expect(markup).toContain("<table")
    expect(markup).toContain('<caption class="sr-only">Example rows. Open a row to inspect it.</caption>')
    expect(markup).toContain("<strong>foo</strong>")
    expect(markup).not.toContain("<article")
    expect(markup).not.toContain("<dl")
  })

  test("reuses table empty messages without invalid table elements in card mode", () => {
    const markup = renderToStaticMarkup(<CollectionTable widths={[200]} defaultView="cards" displayControls={false}>
      <thead><tr><th /><th>Name</th></tr></thead>
      <CollectionTableBody rows={[]} empty={<tr><td colSpan={2}>No matching rows.</td></tr>}>{() => <CollectionRow />}</CollectionTableBody>
    </CollectionTable>)
    expect(markup).toContain("No matching rows.")
    expect(markup).not.toContain("Select all")
    expect(/<(table|caption|thead|tbody|tr|td|th)\b/.test(markup)).toBe(false)
  })

  test("numbered collections do not advertise selection without a checkbox", () => {
    const markup = renderToStaticMarkup(<CollectionTable widths={[200]} defaultView="cards">
      <thead><tr><th>No.</th><th>Name</th></tr></thead>
      <CollectionRow><td>1</td><td>Review session</td></CollectionRow>
    </CollectionTable>)
    expect(markup).toContain("Review session")
    expect(markup).not.toContain("Select all")
  })
})
