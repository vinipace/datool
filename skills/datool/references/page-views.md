# Author Table, React, and MDX Page Views

Use a Page View to save a collection's presentation or replace its content with
a custom screen. Start with [choosing views](views.md) if the request could be
about one record or a frozen report.

## Definition and transport

Discover the resource and `create_page_view` / `update_page_view` schemas on the
deployed server. Canonical MCP, CLI, and browser WebMCP operations share this
input envelope:

```json
{
  "definition": {
    "resource": "traces",
    "name": "Trace review queue",
    "settings": {
      "schemaVersion": 1,
      "renderer": {
        "kind": "react",
        "code": "export default function Page({ rows }) { return <p>{rows.length} loaded traces</p> }"
      }
    }
  }
}
```

- **Table**: omit `settings.renderer`. Save the discovered table/card settings,
  filters, and existing custom field references. Do not invent `kind: "table"`.
- **React**: set `settings.renderer = { kind: "react", code }`.
- **MDX**: set `settings.renderer = { kind: "mdx", code }`.

Table fields omitted from a supported custom renderer definition receive
defaults. Filters and default Object View references can coexist with the
renderer. A Page View references Custom Fields; changing its layout does not
authorize editing those shared field definitions.

For an update, pass `{ id, definition: { resource, name, settings,
expectedRevision } }` using the saved revision. Conflicts retain the draft;
re-read or copy deliberately rather than overwriting another member's changes.
REST uses `/api/page-views` with the definition directly in the request body;
do not put the agent-operation envelope around a REST definition.

Use `list_page_views` / `get_page_view` to inspect existing definitions, and
`resolve_page_view` for the view and its exact dependencies and link. Resolving
does not apply the view in the browser. Use advertised page-selection tools or
the Page View menu to display it. `validate_page_view` validates the definition
and dependencies; it does not execute fields, compile the renderer, or render
the page. A successful API save alone does not establish a working screen.

## React collection contract

Choose **Page View → Create React Page View**, edit the source, **Preview**, and
save. **Edit React component** updates the selected React Page View. Export a
default component receiving `PageViewProps<Row>`:

```tsx
import * as React from "react";
import { Button } from "@datool/ui";

export default function Page({ rows, page, openTrace, refresh, loadMore }: PageViewProps<{ id: string; name: string }>) {
  return <div className="space-y-3 p-3">
    <Button onClick={refresh}>Refresh</Button>
    {rows.length === 0 && <p>No matching traces.</p>}
    {rows.map(row => <Button key={row.id} onClick={() => openTrace(row.id, {
      objectViewId: "rview_example",
    })}>{row.name}</Button>)}
    {page.hasMore && <Button disabled={page.isLoadingMore} onClick={loadMore}>Load more</Button>}
  </div>;
}
```

Replace the example Object View ID with an existing compatible project view,
or omit it to use the normal inspector behavior.

- `rows` follows the resource's actual loaded row contract and active filters.
  Inspect representative rows; dataset items are not trace rows. Pagination
  remains bounded.
- `page` supplies `resource`, `queryParams`, `total` (null when unavailable),
  `isLoading`, `isRefreshing`, `hasMore`, `isLoadingMore`, and `error`.
- `refresh()` and `loadMore()` use the collection's request owner. Guard load
  more with `hasMore` and `isLoadingMore`.
- `openTrace(traceId, { objectViewId?, spanId? })` opens the trace inspector. An
  explicit Object View opens the Views tab and selects that view. Without an
  explicit ID, `settings.objectViews.trace.id` supplies the configured default;
  otherwise the normal inspector tab preference applies.

For dataset items or other collections, obtain the trace ID from recorded row
evidence. Do not pass the dataset item ID as the trace ID.

## MDX source

Choose **Page View → Create MDX Page View**, then use the **MDX** and **Preview**
tabs. **Edit MDX document** updates the selected MDX view.

```mdx
# Trace review queue

Loaded **{props.rows.length}** traces.

<Button onClick={props.refresh}>Refresh</Button>

<DataTable data={props.rows} columns={[{ accessorKey: "name", header: "Name" }]} />

{props.rows.map(row => (
  <TraceButton key={row.id} traceId={row.id} objectViewId="rview_example">
    Inspect {row.name}
  </TraceButton>
))}
```

MDX exposes the React collection contract under `props`, including
`props.openTrace`, `props.refresh`, and `props.loadMore`. Shared `@datool/ui`
components are available by name without imports. `TraceButton` accepts
`traceId`, optional `objectViewId` / `spanId`, and Button styling props. Static
imports support custom React components/hooks and advertised chart components.
Markdown supports headings, lists, code blocks, and GitHub-style tables. This
format uses live collection rows; do not copy the report sources/bindings
format into Page View source.

## Runtime and verification

When advertised, import `react`, `@datool/ui`, and `@datool/charts`. Use complete
semantic Tailwind classes such as `bg-background`, `text-foreground`,
`text-foreground-muted`, and `border-border`. The renderer follows the Datool
theme and runs in an isolated iframe with network access blocked. Use supplied
data/actions instead of fetching application APIs from the component.

Compile and preview before saving through the UI. API-created source must also
be checked in the browser: syntax validation and successful persistence are
not render proof. Inspect loading, empty, error, desktop, and narrow states;
verify refresh/load-more actions and opening the intended trace/Object View.
Collection refreshes preserve component state; changed source replaces the
component. Compile/render errors remain visible, and the menu can switch back
to the default table view. Confirm saved source and revision after writes, and
verify reuse in another authenticated project-member browser when sharing is
part of the task.
