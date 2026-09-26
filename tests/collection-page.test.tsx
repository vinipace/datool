import { describe, expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"

const loaded = {
  data: [{ id: "saved-row" }],
  error: null,
  isLoading: false,
  isRefreshing: false,
  refresh: () => {},
}

function render(
  state: React.ComponentProps<typeof CollectionPage>["state"],
  isEmpty = false
) {
  return renderToStaticMarkup(
    <CollectionPage
      state={state}
      loadingLabel="Loading examples"
      toolbar={<button>Create example</button>}
      isEmpty={isEmpty}
      empty={<p>No matching examples</p>}
      pagination={{
        canLoadMore: true,
        isLoadingMore: false,
        loadMore: () => {},
        loadMoreError: null,
      }}
    >
      <p>Saved row content</p>
    </CollectionPage>
  )
}

describe("shared collection lifecycle", () => {
  test("initial loading preserves resource actions and hides rows, empty state and pagination", () => {
    const html = render({ ...loaded, data: null, isLoading: true }, true)
    expect(html).toContain('role="status"')
    expect(html).toContain("Loading examples")
    expect(html).toContain('data-slot="collection-table-skeleton"')
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain("Create example")
    expect(html).not.toContain("Saved row content")
    expect(html).not.toContain("No matching examples")
    expect(html).not.toContain("Load more")
  })

  test("initial failure offers retry without claiming the collection is empty", () => {
    const html = render(
      { ...loaded, data: null, error: new Error("Connection unavailable") },
      true
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Connection unavailable")
    expect(html).toContain("Retry")
    expect(html).not.toContain('data-slot="collection-table-skeleton"')
    expect(html).not.toContain("No matching examples")
    expect(html).not.toContain("Saved row content")
    expect(html).not.toContain("Load more")
  })

  test("refresh and refresh failure keep previously loaded rows and pagination", () => {
    for (const state of [
      { ...loaded, isRefreshing: true },
      { ...loaded, error: new Error("Refresh failed") },
    ]) {
      const html = render(state)
      expect(html).toContain("Saved row content")
      expect(html).toContain("Load more")
      expect(html).not.toContain("Loading examples")
      expect(html).not.toContain('data-slot="collection-table-skeleton"')
    }
    expect(render({ ...loaded, error: new Error("Refresh failed") })).toContain(
      "Refresh failed"
    )
  })

  test("a successful empty response uses the resource empty state", () => {
    const html = render({ ...loaded, data: [] }, true)
    expect(html).toContain("No matching examples")
    expect(html).not.toContain("Saved row content")
    expect(html).not.toContain("Retry")
  })

  test("table-owned empty states remain available when no page empty state is supplied", () => {
    const html = renderToStaticMarkup(
      <CollectionPage
        state={{ ...loaded, data: [] }}
        loadingLabel="Loading examples"
        isEmpty
      >
        <table>
          <tbody>
            <tr>
              <td>No rows in this table</td>
            </tr>
          </tbody>
        </table>
      </CollectionPage>
    )
    expect(html).toContain("No rows in this table")
  })

  test("shared local search retains accessible labeling and controlled value", () => {
    const html = renderToStaticMarkup(
      <CollectionSearch
        label="Search scorers"
        value="quality"
        onChange={() => {}}
      />
    )
    expect(html).toContain('aria-label="Search scorers"')
    expect(html).toContain('value="quality"')
  })
})
