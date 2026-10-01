# UI design conventions

This is the reference for new UI and changes to existing UI. It defines the trace table and inspector patterns. Extend these patterns across traces, sessions, evals, datasets, and dashboards instead of inventing a new visual language per page.

## Colors: semantic tokens only

- Define colors in `app/globals.css` and expose semantic Tailwind utilities through its theme mapping. Components consume tokens; raw hex, RGB, OKLCH, and named palette classes belong in theme definitions, not component markup.
- Reuse existing tokens such as `background`, `foreground`, `muted-foreground`, `border`, `ring`, `popover`, and the sidebar tokens when their meaning fits.
- Add a token when a distinct UI role needs it. Name it by purpose, not hue: `surface-row`, not `gray-950`.
- Keep foreground/background pairs for colored surfaces. Selection, hover, keyboard focus, and status need distinct, consistent treatments.
- Dark mode is the current visual reference: black canvas, subtly lighter rows and panels, muted secondary text, and restrained indigo selection. Colored span icons communicate kind, not execution status.
- A theme change should require editing token definitions, not finding and replacing colors across components. Avoid per-component opacity adjustments that produce inconsistent versions of the same state.

Token roles to standardize when migrating the remaining hardcoded styles:

| Role | Token family | Appearance / use |
| --- | --- | --- |
| Canvas and primary text | Existing `background`, `foreground` | Black canvas and readable light text |
| Secondary text | Existing `muted-foreground` | Metadata, summaries, row numbers |
| Quiet surfaces | `surface-row`, `surface-panel` | Subtle separation from the canvas |
| Row interaction | `surface-row-hover` | Visible hover without a border |
| Checked rows | `selection`, `selection-foreground`, `selection-control` | Indigo surface and checkbox accent |
| Structural dividers | Existing `border` | Low-contrast panel/header boundaries |
| Keyboard focus | Existing `ring` | Visible focus independent of selection |
| Span kinds | `span-{kind}`, `span-{kind}-foreground` | Cyan workflow/custom; purple agent/LLM/task; orange tool |
| Execution status | `status-{success,error,warning}` | Status text/icons; never inferred from span kind |

`surface-canvas`, `surface-row`, and `surface-row-hover` are implemented in `app/globals.css` and used by sessions. The remaining additional token names are a migration contract, not a claim that they are already implemented. Current trace components still contain hardcoded colors. Replace them with these semantic roles when touching their styling, preserving the approved appearance. Do not treat existing palette classes as precedent.

## Typography

- Inter is the application UI font, loaded once through `next/font/google` in `app/layout.tsx` and connected to the global `font-sans` token.
- Use 14px for trace table content and column labels. Use 12px for supporting summaries, tags, row numbers, and compact JSON previews. Do not shrink operational table text to 10px.
- Keep code and JSON monospace. Use tabular numerals for timestamps, durations, counts, and scores.
- Use sentence case and normal/medium weights. Avoid uppercase, letter-spaced metadata labels and oversized headings inside inspectors.
- Truncate dense table previews; provide complete values in the inspector. Long names must not push adjacent columns out of alignment.

## Surfaces and borders

- Build hierarchy with spacing, typography, and quiet background differences first.
- Do not wrap the table, toolbar, histogram, every row, and every cell in nested borders.
- Table bodies have no vertical cell borders or horizontal gridlines. Use subtle vertical separators in the header only.
- Rows are distinct dark strips separated by a 2px gap, with small rounded outer corners. The histogram is a separate quiet panel.
- Use thin dividers at meaningful boundaries: inspector panes and input/output sections. Avoid bordered cards around ordinary text or JSON.
- Keep corners restrained: 4px for span icons, small radii for rows and controls. Chat user bubbles may be more rounded.

## Trace table behavior

- Use 40px rows, 12px horizontal cell padding, and consistent column alignment. Allow horizontal scrolling rather than compressing text until unreadable.
- Reserve a 44px leading selection column. Unchecked rows show their one-based position in the current visible list, not a persistent trace ID.
- Reveal the checkbox on row hover or keyboard focus; checked rows always show it. Touch devices must expose checkboxes without hover.
- The header checkbox selects/deselects all visible rows and shows an indeterminate state when only some are checked. It does not silently select unloaded records.
- Checked rows use the selection surface. Checking a row must not open its inspector.
- Clicking other row content, or pressing Enter/Space on the focused row, opens the inspector. Checkbox keyboard events must not trigger row activation.
- Key selection by trace ID so live refresh does not move selection to a different trace. Keep checked selection separate from the trace currently open in the inspector.
- Label aggregate scope honestly: visible, loaded, and total are different. Missing measurements stay unavailable rather than becoming zero.

## Span icons and inspector

- `components/tracer/span-kind-icon.tsx` owns span glyphs, colors, dimensions, and shape. Use it in the Name column, tree, detail heading, and tool-call rendering. Do not create a parallel icon map.
- Keep icons 22px square with a 14px glyph and 4px corners. Trace-level entries use the workflow kind consistently.
- The inspector uses a compact header, a tree/timeline pane, and a detail pane. Tree rows are compact and full width, with clear indentation, connecting lines, and right-aligned expansion controls.
- Put root/span metadata on a quiet line above the title. Keep content tabs close to the content.
- Render recognized messages with role labels: plain system/assistant text and an indigo user bubble. Render arbitrary payloads as readable JSON without forcing them into a chat schema.
- Preserve Messages, Details, and Raw access. Do not add decorative controls for unsupported actions or manufacture metrics to match a reference screenshot.

## Review before shipping UI changes

- Check the populated table and an open inspector at desktop and narrow widths.
- Check hover, keyboard focus, checked rows, partial/select-all state, and empty results when affected.
- Confirm shared icons and font sizing match nearby surfaces.
- Confirm new component colors consume semantic tokens and that borders establish structure rather than enclosing everything.
- Preserve real data, navigation, and live updates while changing presentation. Run typecheck and scoped lint for code changes; use visual review for spacing and density changes.

## Shared implementation

Traces and sessions must consume `components/tracer/collection-table-styles.ts` for table, header, row, selection, and cell styles, and `collection-table.tsx` for numbered selection controls. Change these shared definitions instead of recreating the pattern per page. Sessions has no extra page header or New session button above its table. Selection tokens are now defined in `app/globals.css`.

Use `CollectionTable columnIds={["session", "traces", "attributes", "updated"]} widths={[280, 100, 300, 180]}` and `CollectionRow checked={checked}` from `collection-table.tsx` for new lists. `CollectionTable` reserves exactly 44px for selection and gives spare width to the last content column; do not provide a separate colgroup or make every column fixed under a full-width table. `CollectionRow` owns the selected/open state through `data-selected`, with one token-based CSS rule for background and foreground. Do not implement page-specific selected row classes.

JSON uses Geist Mono through `next/font/google`. Use `JsonCode` to highlight JSON with Prism and React text nodes. Syntax colors live in the `--json-*` theme tokens; do not import a hardcoded highlighter theme. UI prose remains Inter, and expanded eval payloads must remain fully visible.

### Resizing and virtualization

- `CollectionTable` uses TanStack Table column sizing in `onChange` mode. Drag a header edge to resize, double-click to reset, or focus its separator and use Left/Right. Selection stays 44px; content columns have an 80px minimum. Supply stable `columnIds`, especially for dynamic score columns, so live updates and visibility changes do not transfer a width to another column. Widths currently last for the mounted view.
- Put data rows in `CollectionTableBody rows={rows}` with a `(row, index) => <CollectionRow ...>` child callback. Do not eagerly map all rows into a `tbody`. TanStack Virtual mounts only the visible window plus 12 overscan rows on each side, keyed by row ID.
- The shared scroll viewport is bounded by available window height and keeps the header sticky. Rows are measured with ResizeObserver, so wrapped eval JSON grows naturally and remeasures after a column resize. Use `estimatedRowHeight={300}` for expanded eval results; compact lists use the default.
- Keep checkbox state and aggregate calculations over the full filtered/loaded data, never just the mounted virtual rows. Preserve the existing token-based row appearance and custom cell renderers.

### One shared page header

- The shell owns a single sticky, non-wrapping row: sidebar collapse, page title, flexible filter field, refresh, Display, and an ellipsis menu. Export belongs inside that menu. Do not add another filter/action toolbar or Local API badge above the content.
- Use `CollectionHeaderControls` from `collection-header.tsx` to publish page filters, refresh and export actions into the shell slots. Portals preserve the page's state and handlers; components clean up automatically on navigation.
- `CollectionTable` provides the shared Display column menu by default. Pages with their own column model (traces) use `HeaderDisplay` and set `displayControls={false}` on their table. Column visibility must affect both headers and row cells.
- Filter guidance must not create a permanent second row. Show validation errors below the field only when present. Keep autocomplete above the table and keep header actions visible at narrow widths.
