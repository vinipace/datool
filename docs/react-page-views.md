# React and MDX Page Views

A Page View can replace a collection's content with a custom React component or
an MDX document combining Markdown, JSX, and expressions using live page data.
The Page View menu, collection filters, and query owners stay mounted. Existing
table/card Page Views continue to work.

Choose **Page View → Create React Page View**, enter a name, edit the component,
and use **Preview** before saving. **Edit React component** updates the selected
React Page View. Source is shared within the project, with the same revision
checks, history, copy, and restore operations as other Page Views.

## Component contract

Export a default component receiving `PageViewProps<Row>`. Static imports from
`react`, `@datool/ui`, and `@datool/charts` are supported, using the same compiler,
theme, and isolated iframe as Object Views.

```tsx
import * as React from "react"
import { Button } from "@datool/ui"

export default function Page({
  rows, page, openTrace, refresh, loadMore,
}: PageViewProps<{ id: string; name: string }>) {
  return <div className="space-y-3 p-3">
    <Button onClick={refresh}>Refresh</Button>
    {rows.map(row => <Button key={row.id} onClick={() => openTrace(row.id, {
      objectViewId: "rview_your_project_view",
    })}>{row.name}</Button>)}
    {rows.length === 0 && <p>No matching traces.</p>}
    {page.hasMore && <Button disabled={page.isLoadingMore} onClick={loadMore}>Load more</Button>}
  </div>
}
```

- `rows`: currently loaded collection rows, following the resource's row contract
  and active filters. Pagination remains bounded; these are not all project rows.
- `page`: `resource`, `queryParams`, `total` (null when unavailable),
  `isLoading`, `isRefreshing`, `hasMore`, `isLoadingMore`, and `error`.
- `refresh()` and `loadMore()`: use the collection's existing request owner.
- `openTrace(traceId, { objectViewId?, spanId? })`: opens the existing trace
  inspector. An explicit Object View opens its Views tab and selects that view.
  Without an explicit ID, `settings.objectViews.trace.id` supplies the default
  if configured. Without either, the normal inspector tab preference applies.

React Page Views on other collections, such as dataset items, can open traces in
the same way. Use a trace ID from the row's evidence, not the dataset item ID.
An unavailable or incompatible Object View produces the inspector's existing
error state.

The iframe cannot fetch application APIs directly. Navigation and collection
actions pass through a bridge that checks the originating frame, view token,
and trace-opening payload. Compile/render failures remain visible, and the Page
View menu remains available for switching back to the default collection.

## Saved definition

Canonical REST endpoints and CLI/MCP/WebMCP Page View operations accept
`settings.renderer = { kind: "react" | "mdx", code }`. For example:

```json
{
  "resource": "traces",
  "name": "My trace page",
  "settings": {
    "schemaVersion": 1,
    "renderer": { "kind": "react", "code": "export default function Page({ rows }) { return rows.length }" }
  }
}
```

Table fields can be omitted and receive neutral defaults. Existing filters,
custom field references, and default Object View references can still be saved
alongside the renderer. Omitting `renderer` uses the collection's table/card
presentation. Updating uses `expectedRevision`; a stale save returns a conflict
and keeps the editor draft available.

## MDX documents

Choose **Page View → Create MDX Page View**. Write MDX in the source tab, use
**Preview**, and save. **Edit MDX document** updates the selected MDX view with
the same revision checks and shared storage as React views.

MDX receives the same data and actions under `props`: `props.rows`,
`props.page`, `props.refresh()`, `props.loadMore()`, and `props.openTrace()`.
Markdown supports headings, lists, code blocks, and GitHub-style tables.
Shared `@datool/ui` components are available by name without importing them.
Use static imports when declaring your own components or using React hooks;
chart components can be imported from `@datool/charts`.

```mdx
# Trace overview

Loaded **{props.rows.length}** traces.

<Button onClick={props.refresh}>Refresh</Button>

<DataTable data={props.rows} columns={[{ accessorKey: "name", header: "Name" }]} />

{props.rows.map(row => (
  <TraceButton key={row.id} traceId={row.id} objectViewId="rview_your_project_view">
    Inspect {row.name}
  </TraceButton>
))}
```

`TraceButton` accepts `traceId`, optional `objectViewId` and `spanId`, and shared
Button styling props. It opens the existing inspector through the validated
bridge. MDX source and expressions compile in the same worker and run in the
same isolated iframe as React views. Invalid syntax is shown in the editor and
prevents saving; definitions created through APIs show compile errors on load.
Switching to the default Page View remains available.

Store MDX using `settings.renderer = { kind: "mdx", code: "# Overview\n\n..." }`.
Page View MDX uses live collection data; the separate report authoring format
continues to use its captured sources and bindings.
