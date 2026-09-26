# React trace views

Custom views run in an iframe with `allow-scripts`, without same-origin access or network requests. View definitions live in the project database and work across traces, dataset rows and teammates. See [project React views](./react-views.md) for persistence, origin metadata and compatibility. Export a default component receiving `{ trace }: ViewProps`.

Supported imports:

- `react`: hooks and React primitives.
- `@datool/ui`: Datool's Button, Input, Select, Card family, Notice, Tabs family and DataTable.
- `@datool/charts`: Recharts exports plus Datool's ChartContainer, ChartTooltipContent and chart legend components. This bundle is loaded only for views importing it.

DataTable accepts `data`, TanStack `columns`, `caption` and optional `emptyMessage`. It supports sorting and renders at most 50 rows per page. It reuses Datool's table styling without workspace or query dependencies.

Use static Tailwind classes, including responsive classes, arbitrary values and conditional branches containing complete class names. Dynamically constructed names such as `text-${color}` cannot be discovered. Datool's tokens and shared component styles are included in the iframe; its light/dark mode follows the app.

Saving compiles TSX and Tailwind in a short-lived worker. The compiled artifact is cached by source and runtime build, including a bounded persistent cache when storage is available. Trace updates send only data and preserve component identity and local filters. A new trace or edited code resets view state. The first uncached compilation still downloads the compiler; it is absent from the renderer bundle and does not run on the main UI thread.

In the editor overflow menu, choose **Input and output only** for diagnosis/result views. The inspector fetches root payloads and omits child spans and scores. Choose **Complete trace with spans and scores** when those fields are required. New UI views start with input/output data; the API defaults to complete data when dataMode is omitted. The mode is saved with the project view. Editor types are generated from the actual components and loaded only when editing.

Build assets with `bun run build:monaco` (also part of `dev` and `build`). Generated files live under ignored `public/trace-views/`; rebuild and reload after changing the renderer, compiler, shared components or theme.

The example in `examples/trace-views/evidence-diagnosis.tsx.txt` visualizes an example `review_dossier` with actions, ranking, evidence confidence, linked facts, audit decisions, cards, a sortable table and a category chart. Confidence describes evidential support, not probability of business success.

For a local preview, place a recorded TraceDetail JSON in ignored `artifacts/trace-view-demo.json`, run `bun run dev --port 3000`, and open `/ui-reference/trace-views`. This development-only page uses the production view component and provides a trace-update button for checking state retention. Recorded customer evidence must remain ignored and must not be committed. The preview does not execute the diagnosis workflow or require a database.

Agents can discover the browser's `list_trace_views`, `get_trace_view`, `create_trace_view`, `update_trace_view`, `select_trace_view` and `delete_trace_view` WebMCP tools from the Datool app shell. Create/update accept `dataMode: "summary" | "full"` and await compilation before persisting. These project React views are separate from saved selector views or custom evaluation display views in the server MCP/CLI catalog. Read each live tool schema: a deployed older runtime may not support shared imports or Tailwind.
