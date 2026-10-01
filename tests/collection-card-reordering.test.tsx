import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "bun:test"
import { CollectionTable, CollectionRow, CollectionSelectAll } from "@/components/tracer/collection-table"

function Example({ view = "cards" }: { view?: "cards" | "table" }) {
  return <CollectionTable defaultView={view} widths={[200, 200]} columnIds={["name", "output"]} displayControls={false} reorderable selectionActions={<button>Details</button>}>
    <thead><tr><th><CollectionSelectAll checked={false} partial={false} disabled={false} label="Select all examples" onChange={() => {}} /></th><th>Name</th><th><button>Edit output</button></th></tr></thead>
    {[1, 2].map(id => <CollectionRow key={id}><td /><td>Target {id}</td><td>Output {id}</td></CollectionRow>)}
  </CollectionTable>
}

test("repeated card fields use independent drag contexts and preserve editor controls", () => {
  const html = renderToStaticMarkup(<Example />)
  const labels = [...html.matchAll(/<dt\b([^>]*)>(.*?)<\/dt>/g)]
  expect(labels).toHaveLength(4)
  expect(labels.every(([, attributes]) => attributes.includes('tabindex="0"'))).toBe(true)
  const descriptions = labels.map(([, attributes]) => attributes.match(/aria-describedby="([^"]+)"/)?.[1])
  expect(descriptions[0]).toBeDefined()
  expect(descriptions[0]).toBe(descriptions[1])
  expect(descriptions[2]).toBe(descriptions[3])
  expect(descriptions[0] === descriptions[2]).toBe(false)
  expect(labels.map(([, , content]) => content)).toEqual(["Name", "<button>Edit output</button>", "Name", "<button>Edit output</button>"])
})

test("selection stays in the table header or card toolbar alongside a single Details button", () => {
  for (const view of ["cards", "table"] as const) {
    const html = renderToStaticMarkup(<Example view={view} />)
    expect(html.match(/aria-label="Select all examples"/g)).toHaveLength(1)
    expect(html.match(/<button>Details<\/button>/g)).toHaveLength(1)
    if (view === "table") {
      const header = html.match(/<thead\b[^>]*>(.*?)<\/thead>/)?.[1]
      expect(header).toContain('aria-label="Select all examples"')
      expect(html).not.toContain('</label><button>Details</button>')
    } else {
      expect(html).toContain('</label><button>Details</button>')
    }
  }
})
