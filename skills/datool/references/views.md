# Choose Page Views or Object Views

Choose by the data the user wants to organize, then choose the source format.

| User goal | Choose | Data and surface |
| --- | --- | --- |
| Save filters, sorting, columns, custom field references, or table/card layout | Table Page View | An existing collection with its normal table/card presentation |
| Build a review queue, cards, charts, or interactions across the loaded collection | React Page View | `PageViewProps`: `rows`, `page`, and collection actions |
| Combine Markdown narrative with live rows, JSX, tables, and trace links | MDX Page View | The same collection contract under `props`, plus shared components and `TraceButton` |
| Render one trace's input/output or spans, or one dataset item's current values | Object View | One record under `object`, with `kind`, `context`, and `fields` |
| Save an analytical document with captured evidence and publication history | MDX report | The separate report sources/bindings contract; follow [reports](../../datool-analytics/references/reports.md) |

A trace with many spans or messages is still one object: use an Object View for
its detail visualization. A screen organizing several traces or dataset items
is a Page View. Markdown does not determine scope: MDX Page Views remain live
collection screens, while reports preserve captured evidence.

Examples:

- "Show failed traces as a review queue" → React Page View, or MDX if narrative
  is central to the requested screen.
- "Explain this trace's tool calls and output" → Object View.
- "Add a Markdown introduction above the dataset rows" → MDX Page View.
- "Keep these filters and columns for the team" → Table Page View.
- "Save this evaluation analysis for a reviewed release" → MDX report.

Use both view families when needed: a Page View handles collection navigation;
`openTrace(traceId, { objectViewId, spanId })` opens the trace inspector with the
chosen Object View. MDX offers the same action through `TraceButton`. Obtain
the Object View ID from the project library. A dataset item must use its
recorded source trace ID for this action, not its item ID.

Read [Page View authoring](page-views.md) for Table, React, and MDX definitions,
or [Object View authoring](trace-views.md) for one-record components and legacy
trace compatibility. Reuse an existing suitable definition before creating a
duplicate; update shared definitions only within the user's requested scope.

## Discovery and persistence

Current Page Views and Object Views are shared project resources with revision
checks and history. The browser's current selection or editor draft is separate
from the shared definition. Older browser-local trace views are a legacy
deployment behavior, not the current persistence model.

Discover `get_view_capabilities` and the needed operation schemas through the
configured MCP/CLI connection or browser WebMCP. Inspect
`create_page_view.definition.settings.renderer` for supported `kind` values;
the presence of Page View operations alone does not establish React/MDX support.
Browser-local selection tools and server persistence tools have different
effects. Read their live descriptions rather than inventing tool names.

The CLI aliases `page-views` and `object-views` need installed CLI support. If an
alias is absent but the deployed server exposes the operation, use
`datool agent call <operation> --input @input.json`. A prepared application or
skill change does not prove deployment, publication, or permission grants.

Loaded Page View rows are a bounded, changing collection, not a project-wide
snapshot. Use [analytics](../../datool-analytics/SKILL.md) for population metrics
and [datasets](../../datool-datasets/SKILL.md) for frozen evaluation cases.
