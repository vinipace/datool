# Shared product patterns

For colors, controls and visual review, follow [the UI style standard](./ui-style-standard.md). Traces supplies the visual reference; shared theme tokens and controls carry that appearance into auth, settings and collection pages.

New collection pages should compose existing behavior before adding page-specific controls. Compose `CollectionPanel` with `CollectionPage` for the page navigation / data toolbar split; dashboards, agents, workflows, sessions, reviews, human scores, eval runs, scorers and alerts use this structure. Resource queries, columns, navigation and mutations remain owned by the resource page.

For browser titles, follow [Page titles and metadata](./page-metadata.md). Every
rendered server page exports metadata using the shared title catalog; the root
layout applies the `Page · Datool` format.

## Owners

| Behavior | Canonical owner | Usage |
| --- | --- | --- |
| Page title/breadcrumbs, filter and action placement, flexible content | `components/tracer/page-layout.tsx` | Mounted once by the app shell; also used by Storybook frames. |
| Collection layout, loading, retry, refresh, pagination | `components/tracer/collection-page.tsx` | Supply request state, header configuration and resource content. |
| Panel-local collection controls and flexible content | `components/tracer/collection-panel.tsx` | Owns the data toolbar and scrolling body on Traces and the adopted collection pages; keep inspectors outside this control scope. |
| Header slots, refresh and export actions | `components/tracer/collection-header.tsx` | `CollectionPage` composes these; detail pages may use them directly. |
| Collection filter bar | `collection-filter.tsx`, `use-collection-filter.ts` | Use registered resource fields and retain the last valid filter; apply it in the resource query or to a fully loaded local collection. |
| Plain text search | `CollectionSearch` in `collection-page.tsx` | Use for secondary local search fields, not as a replacement for the shared collection filter bar. |
| Cursor pagination and polling | `use-collection-pages.ts` | Pass its result as both `state` and `pagination`. |
| Non-paginated request state | `hooks.ts` / `useRemote` | Pass its result as `state`. |
| Table/card rendering, display controls, column ordering | `collection-table.tsx` | Reuse row cells and headers; opt into supported table capabilities. |
| Page View menu and Display controls | `table-view-controls.tsx`, `custom-view-controls.tsx`, `components/ui/page-view-menu.tsx` | Already composed by `CollectionPage`; pass `savedView` when supported. Page Views sit before the filter bar. |
| Custom React Page View content | `page-view-surface.tsx`, `react-page-view.tsx` | `CollectionPanel` supplies the replacement content slot. `CollectionPage` supplies loaded rows and request state; other collection owners use `PageViewDataSource`. See [React Page Views](./react-page-views.md). |
| Table preferences and saved-view settings | `use-table-view.ts` | Persist visibility, widths, order and presentation locally. Pass `resource` for saved views; computed columns are optional. |
| Custom-column agent tools | `collection-table.tsx`, `use-column-webmcp.ts` | Supply the computed-column store; do not register duplicate page tools. |
| Trace inspector overlay | `trace-list-overlay.tsx` | Reuse the overlay and its focus behavior. |
| Inspector panels | `inspector-panels.tsx` | Compose existing panels and context instead of another inspector. |
| Input/output and dataset value presentation | `components/ui/structured-value-view.tsx`, `structured-value-viewer.tsx`, `value-view-select.tsx` | Share rendering and format selection; dataset tables keep their field settings in Display. |
| Large values loaded on demand | `components/ui/deferred-value.tsx` | Show a blurred bounded preview, size, load button and inline retry error. Mount the value editor only after the field is fetched. |

Paths in the table are under `components/tracer/` unless specified otherwise.

`CollectionTable` is the shared renderer for resource collections, including
traces, datasets, evals, scorers, reports, projects and members. Its name follows
`CollectionPage`, `CollectionPanel` and `CollectionHeader`; resource pages own
their queries and row content.

`CollectionTable` exposes one Display view picker by default: Compact, Tall, and Card.
Column visibility is managed in Display, including restoring hidden columns.
Compact is the default and clips text previews to one line, including structured
values and computed columns. Controls, avatars, and percentage cells retain their
full height within the compact row so score progress bars remain visible.
Tall wraps previews, and Card reuses the same headers
and cells. Pass `persistenceKey` to save visibility, sizing, order and presentation
through `useTableView`; the table scopes this key to the current organization and
project. Existing `orderStorageKey` values remain supported.

For tables with named saved views or externally rendered value formats, call
`useTableView` and pass its settings, change handler and column-order store to
`CollectionTable`. Its `selectedView` and `details` props preserve URL selection and
Details-panel behavior on eval run details. Saved views include row height; older
views without it mean Compact. Do not create page-local table settings stores.

Page Views use one searchable menu on logs, evals, eval runs and dataset items.
A yellow dot after the name marks changes to filters, grouping, columns or display
settings. Drafts, their original saved revision, and the selected view persist in
local storage per project and page. Switching views retains each draft. Shared
definitions change only through **Save changes** in the menu; **Reset** restores
the saved definition (or the default view). The menu has a compact row of
Duplicate, Reset and Save icon buttons; Reset and Save are disabled when clean.
Restored preferences establish the default view's local baseline once, so loading
the page does not create a draft. This baseline stays separate from later edits.
The first save of the default view
asks for a name. Save conflicts retain the local draft. Catalog reads are cached
per project/resource for the browser session and updated after explicit saves;
opening the menu or changing display settings never refetches the catalog.

Eval details and comparisons use a resizable sidebar when the content container
is at least 768px wide. Below that width, the results keep the full content area
and Details or Compare opens a scrollable `DialogContent variant="sheet"`.
Opening or closing the mobile sheet does not change the saved desktop Details
preference. Nested hover cards use `OverlayContainer` to stay inside the sheet's
focus boundary.

Docked trace inspectors maximize in place with the header's maximize control.
The shallow `inspector=full` query uses the native History API; the existing
inspector and collection stay mounted, preserving their state and split width.
Escape, the restore control, or browser Back returns to the split view. Nested
dialogs and pickers handle Escape first. A directly opened maximized URL restores
by removing that query parameter rather than leaving the page.
The close control dismisses the inspector in either size and clears its URL
selection; it does not first restore the split view.
When the available workspace is narrower than 768px, traces always fill it.
The maximize/restore control is hidden, and Close or Escape returns to the list.
This responsive expansion does not add a history entry or change the desktop
split width; widening the workspace restores the desktop layout.

Configure additional select settings with `displaySettings` groups containing
labels, values, options and change callbacks. `HeaderDisplay` owns the submenu
markup and interaction. Dataset field formats use this prop. Specialized surfaces
such as the dataset tree can disable table capabilities with `enableCardView`,
`enableRowHeight`, `displayControls` and `reorderable`; do not fork Display.

```tsx
<CollectionTable persistenceKey="eval-runs" columnIds={columnIds} widths={widths}>
  {/* Existing headers and CollectionTableBody rows. */}
</CollectionTable>
```

## Structured value views

`MessageTranscript` right-aligns user labels and message bubbles with a `min-w-8` minimum. The shared `message-user` and `message-user-foreground` tokens provide a white surface and dark text, including readable Markdown code backgrounds. Tool-call disclosures reuse `SpanKindIcon` with the `tool` kind so their icon matches the trace hierarchy.

In trace and span inspectors, output message views omit an exact input-message
prefix when both payloads contain a `messages` state envelope. New repeated
messages remain visible. JSON, YAML, Tree and Raw retain the full captured state;
review annotations retain the full transcript so saved text offsets stay stable.
Single-batch LangChain message arrays render as one transcript; multiple batches
stay structured rather than combining separate conversations.

Expanded tool-call arguments use the shared read-only Monaco `CodeEditor`, with
formatted JSON and syntax highlighting. Editors mount only while their disclosure
is open. Non-JSON and truncated strings remain readable as captured plain text;
the underlying payload and JSON/Raw views remain unchanged.

Tool results retain `tool_call_id`/`toolCallId` through message normalization and
join the preceding matching call in its disclosure, below Input. Match by ID,
never by tool name or completion order; unmatched results stay visible. Output
also uses read-only Monaco, with semantic success/error tints and a status label.
Explicit errors, failed status and nonzero exit codes select the error tint.
`CodeEditor tone` owns these backgrounds and makes Monaco's canvas transparent
within tinted editors without changing other editors' themes.

`src/lib/tracer/value-views.ts` owns view names, labels, availability and defaults.
`StructuredValueView` renders the selected format; `StructuredValueViewer` adds
an independent picker for read-only input/output sections. `ValueViewSelect`
also supplies the dataset editor's picker, including dialog focus handling.
Dataset tables use the same format registry in their existing Display menu and
retain per-field view settings.

`components/ui/chat.tsx` owns the playground conversation and message composer.
Managed Prompts also uses this chat surface, with variable controls in its composer toolbar.
`components/tracer/project-model-field.tsx` owns project model discovery for both prompt and scorer editors.
The Prompts collection and split editor live in `prompts-page.tsx` and `prompt-editor.tsx`; see [Managed prompts](./managed-prompts.md) for versions and agent access.
It shares `MessageTranscript` with the trace payload viewers, using its `chat`
variant to align user messages to the right. The playground owns message history,
connected-agent requests and trace selection; the shared chat surface owns
scrolling, waiting feedback and Enter/Shift + Enter behavior.

Recognized message arrays and adapter output envelopes offer LLM (Markdown) and
LLM Raw (literal message text), with role labels, tool arguments and a captured
content fallback for other content types. Trace payloads default to LLM for
messages, Text for strings and JSON otherwise. JSON, YAML, Text, Pretty and Tree
remain available for all values. JSON/YAML/Tree use the original captured value,
including envelope fields that are outside the transcript. A message view on a
non-message dataset row falls back to that value's default presentation.
`components/ui/syntax-code.tsx` supplies JSON and YAML highlighting using the
central syntax colors in `app/globals.css`, including scalar values in Tree and
JSON/YAML code blocks in LLM messages. Text and LLM Raw retain literal text.

View selection never changes a dataset draft. LLM, LLM Raw, Pretty and Tree are
read-only previews; JSON/YAML and string Text retain the existing editing
contract. Invalid drafts stay visible in their original editable format. Keep
trace loading, missing payloads and request errors outside the value renderer.

## Page layout

Pages with sibling panels can portal a shared `TabsList variant="panel"` into
`HeaderSlot name="tabs"`. `PageLayout` places these tabs along the header's bottom
edge and keeps the page title available to screen readers. Pair the tabs with
`TabsContent` around each panel; the active tab shares the panel background and
provides standard keyboard navigation. Human Scores and Collections use this
pattern. Keep tab styling in `components/ui/tabs.tsx`.

The standard separates page navigation from panel data controls. The page
header contains the sidebar toggle, breadcrumbs and page identity.
`CollectionPanel` owns search/filters, resource actions, refresh, Display and the
export menu above the content. Traces, dashboards, agents, workflows, sessions,
reviews, human scores, eval runs, scorers and alerts use this structure. The toolbar stays within the
table side of the resizable split; the inspector starts directly below the page
header. The toolbar stays on one row as the panel narrows: search shrinks while
action buttons retain their size. The toolbar is a named `collection` container;
below 640px, the shared filter surface floats across its full inner width while
focused or editing a filter chip. Suggestions follow the expanded surface, and
the table and inspector stay in place. Blurring search restores its compact width.
Below 480px of panel width, Refresh moves into the overflow menu to leave more
room for search. Wider panels show the standalone Refresh button. The panel
shares this state through the header context because dropdown content is portaled
outside its CSS container.
Reserve the toolbar's 53px height before its portal targets mount, using the
same toolbar skeleton as route loading. Measure the initial compact layout before
paint so Refresh does not briefly appear and then move into the menu. Display's
placeholder uses the same button sizing and label footprint as the loaded control.
Persistent controls beside Display belong in `header.displayActions`.
Pass `CollectionPage.selection` with the selected rows, an `onClear` callback,
and optional resource actions. `CollectionSelectionActions` uses the shared
`SelectionToolbar` for the count, clear action and selected-row JSON export.
`CollectionPanel` replaces its normal controls through the selection header slot
while retaining the mounted filters and Display state. Counts and exports use the
same loaded, visible selected rows; removed or filtered-out rows never inflate the
count. Evals supplies Compare as a selection action. Traces retains its specialized
actions through `selectionControls`. Keep selection actions out of the table body.
Resource actions use `PanelActionLabel` beside their icons: labels remain
accessible while visually collapsing below 640px of toolbar width.
`CollectionPanel` scopes the existing header slots so table-owned
Display controls land beside that table's search. Its body retains flexible
table scrolling and scrolls overflowing loading, empty or error content.

`PageLayout` owns the compact page header and remaining content area. The app
shell mounts this frame once. Put each collection in `CollectionPanel`, with
`CollectionPage className="contents"` inside: the panel owns spacing and scrolling,
while the collection owns loading/retry/pagination and saved views. Supply filters
through `header.children` and primary buttons through `header.actions`; table-owned
Display controls automatically use the panel's slot. Do not repeat the page title
in the toolbar. Keep search outside any results subtree keyed by the applied query,
so result reloads preserve input focus (see `PerformancePage`). Specialized views
can compose `CollectionHeaderControls` directly inside the panel, as Traces does.

Dataset, project and detail/editor layouts retain their existing composition until
migrated separately. The rollout above changes collection pages, not their editors.

Trace inspector disclosures use `useTraceSectionDisclosure` from `components/tracer/hooks.ts`.
Input, Output, Error, scores and custom fields retain their expanded/collapsed
state in local storage across traces, spans and inspector mounts. Keys identify
the section (or custom field ID), never the trace. Following an annotation can
temporarily reveal its field without changing the saved preference.
The navigator/details split uses `useDefaultLayout` with `defaultLayout` and
`onLayoutChanged`. Wide and stacked layouts have separate local-storage keys;
only user resize interactions save a layout, so mounting or changing viewport
size cannot overwrite the preferred split.

Detail pages can provide their loaded name with `HeaderSlot name="title"`.
The layout keeps its route title as the loading/error fallback and restores it
when the detail unmounts. The app shell supplies parent breadcrumb links; dashboard
details show `Dashboards > Dashboard name` in the header. Their content toolbar
uses the shared `Input variant="title"`, matching review titles: read-only beside
the filter bar in view mode, editable beside Add widget and Done in edit mode.
The filter bar is hidden while editing; its filter state is retained across modes.
Scorer editors use `/scorers/new` and `/scorers/<id>` within the project route.
The shell supplies the Scorers breadcrumb during loading, errors and editing;
the editor supplies its title and actions through the same header slots.
Detail pages load the selected scorer by ID so direct links and reloads work.
The scorer creation route accepts optional `traceIds=id1,id2` (repeated
`traceIds` parameters also work). The Score traces modal carries the selected
IDs into this route; its Test trace combobox chooses recorded evidence or a
custom JSON sample. Recorded tests use the same full-evidence scorer execution
as evaluation runs and return previews without saving trace scores.
Starting scorers from a trace selection creates a background evaluation and
opens its saved run URL. The detail page reloads persisted progress and polls
until completion; if navigation is interrupted, the run remains available in
Evals. Background execution uses the persistent server process; server restarts
mark interrupted runs as failed rather than resuming them.

Every playground invocation creates a connected experiment in Evals before the
handler runs, including runs without scorers and failed invocations. The saved
target freezes invocation input/output, correlated traces and selected scorer
versions. Invocation traces carry their app's workflow or agent group so they
also appear in the corresponding collections.

Experiment details show per-scorer execution progress from saved targets,
score spans and results. Queued means no attempt has started; running means an
attempt is in progress or its result is being saved. Aggregate counts cover all
targets, independent of the loaded table page. Terminal runs show interrupted
attempts as errors and unstarted work as skipped. Keep execution status separate
from score quality: a below-threshold grade is still a completed scorer.

`RunTraceInspector` composes the shared inspector frame, evaluator list, timeline
renderer and React views. Its forest and timeline preserve every captured trace
as an independent root. Custom views use the selected trace's full payload;
the multi-trace picker selects which captured tree to render. Keep these controls
shared with `TraceInspector` when extending either surface.


Collection headers use the actual `CollectionFilterBar` from Traces, including
field/value suggestions, typed expressions, filter chips and validation. Add a
resource to `collectionFilterFields` instead of substituting a plain input or
separate type/status dropdown. Scorers applies the shared predicate to its fully
loaded catalog; its name, slug, description, type, revision and dates are filter
fields. Paginated resources must apply filters before pagination on the server.

Existing plain-text collection searches use `TextSearchInput` through
`CollectionSearch`. Both plain text and token filters compose
`components/ui/datool/search-bar/search-bar-surface.tsx`, which owns their height,
search icon, colors, border, focus ring and narrow-panel expansion. Keep local
text filtering immediate; sharing the surface does not change query semantics.

For a standalone view or Storybook example, the layout also accepts `title`,
`breadcrumbs` (an array of `{ label, href }`), `filters` and `actions` directly.
Storybook's project frame uses this production layout so header changes are
visible in every page story.

```tsx
const search = useCollectionFilter("scorers")
const matches = useMemo(() => compileCollectionFilter("scorers", search.filter), [search.filter])
const rows = (state.data ?? []).filter(matches)

<CollectionPanel label="Scorers">
  <CollectionPage
    className="contents"
    state={state}
    loadingLabel="Loading scorers"
    header={{
      children: <CollectionFilterBar resource="scorers" {...search} />,
      actions: <NewScorerButton />,
      exportRows: rows,
    }}
  >
    <ScorerTable rows={rows} />
  </CollectionPage>
</CollectionPanel>
```

## Collection contract

Agents and Workflows aggregate by name across versions before pagination. Their
Versions column uses the semantic `versionCount` measure: distinct non-null
recorded versions among operations matching the current filters and time range.
Unversioned operations remain in operation counts, latency, errors and cost.
Calculate metrics from the combined observations, not from per-version averages.
Entity links filter Traces by group type and name without restricting version.

`CollectionTable` owns the single Display menu for its columns and presentation. Do not
add a second menu in a resource toolbar: built-in, score and computed columns
must use the table's visibility state so hidden columns can be restored there.
`CollectionPage` already groups this menu with `CustomViewControls`. Connect
`useTableView` to `savedView`, `settings`, `onSettingsChange` and
`columnOrderStore` when the resource supports saved views. Scorers uses this same
contract as Agents, Workflows and Playground; its settings are stored per project
in the browser and saved views are shared within that project. Its existing
browser column-order key is retained.

- `state.data === null` means no successful response yet. An empty array or empty page object is a successful response.
- Initial loading uses `components/ui/collection-skeleton.tsx`: a screen-reader loading status with placeholders matching the table header, compact rows and row gaps. `CollectionPage` keeps real search and resource actions mounted and reserves the table-owned Display slot until the table loads. The skeleton clips to the available panel height and width; it does not introduce scrollbars or focusable fake controls. Traces adds placeholders for its histogram and count above the same table skeleton. Initial failure shows an alert and retry, without claiming there are no records.
- Automatic polls and visibility-triggered refreshes are silent across `useRemote` and `useCollectionPages`: retain loaded content, keep refresh icons still, and do not show filter spinners or toggle loading feedback. Explicit refreshes, new query loads and loading more retain feedback. `isRefreshing` describes explicit refresh feedback; `useCollectionPages.isFetching` tracks every in-flight request for pagination coordination.
- Refresh failures preserve previously loaded content and pagination alongside the error.
- Background retries keep an existing error visible until a successful response clears it; starting a poll does not dismiss and re-add the error.
- Resource actions remain available while loading or after failure, including creation of the first item.
- Use `isEmpty` and `empty` for a page-level empty state. Omit `empty` to retain table-owned empty rows.
- Header exports retain the supplied rows and callbacks. Resource pages decide whether to export selected or loaded rows.
- Filters, saved views, selection and inspector state retain their existing persistence scopes. A shared layout does not introduce new storage.
- Keep the collection content flexible (`flex-1 min-h-0`) so tables scroll inside the workspace; toolbars and pagination do not shrink.
- Trace tables use `CollectionTable.pagination` (forwarded by `TraceListTable`) to append pages automatically near the end of the table or card viewport. `InfiniteScroll` also serves trace lists in sessions and review selection; place it inside their scroll container. Keep loaded rows on page errors and show an explicit retry. Eval details and comparisons use `useCollectionPages` with `refreshLoadedPages` to keep all loaded results current while a run is active.
- `CollectionTable` always hides native scrollbars for both tables and cards. Retain `overflow-auto`, its focusable scroll region and native wheel/touch/keyboard scrolling; do not hide overflow or add page-specific scrollbar flags.

```tsx
const search = useCollectionFilter("sessions")
const page = useCollectionPages(tracerApi.sessions.list, search.filter)

return <CollectionPage
  state={page}
  loadingLabel="Loading sessions"
  pagination={page}
  header={{
    exportRows: page.items,
    exportName: "sessions",
    children: <CollectionFilterBar resource="sessions" {...search}
      isLoading={page.isLoading || page.isRefreshing} />,
  }}
>
  <SessionTable rows={page.items} />
</CollectionPage>
```

## Trace inspector loading

Trace-list selections use the native History API, which synchronizes Next's
search params without a server navigation. Open the inspector immediately with
a skeleton while its overview loads; keep navigation and close controls usable.
Preserve the list filter, one inspector history entry, and row focus on close.

Session detail routes reuse `SessionTraceInspector` and the shared inspector
workspace. At widths below 640px, the hierarchy or timeline opens in a left sidebar
using `DialogContent variant="sidebar"`; selecting an item closes it and leaves
the detail pane at full width. Escape and the close button dismiss the sidebar and
return focus to its trigger. Wider workspaces keep their saved resizable split.
Embedded app previews can pass their positioned frame element as
`DialogContent container={frame}` and use `Dialog modal={false}`. This keeps the
sidebar and backdrop inside the frame while leaving the surrounding page
scrollable. Dialogs without a container retain their viewport positioning and
normal modal behavior.

The selectable session root contains an explicit row for each trace,
followed by its original span hierarchy. Selection and collapse are scoped by
trace ID; `?trace=...&span=...` links reopen the same child. The session root is
presentation only, never a synthetic persisted trace or span. Session navigation
uses `SessionKindIcon`: circular message bubbles on the semantic yellow session
surface, with a black stroke and 10% black fill.

`session-detail-loader.ts` reads all trace and score pages, loads compact span
overviews with bounded concurrency, and orders traces chronologically. Payloads
remain lazy. Initial failures show retry; refresh failures preserve the last
complete hierarchy and display an error. The session root shares the trace
Overview, Details, Metadata and Raw tabs. Overview lazily loads all trace payloads
and span pages with bounded concurrency, then uses `MessageTranscript` for the
chronological conversation. Replayed model history is merged by contiguous overlap;
repeated turns remain distinct. System/developer instructions remain on the model
spans. Plain trace input/output text is the fallback when there are no model
messages. Completed payloads are cached within the session; running traces refresh
with the hierarchy. Incomplete conversation requests show retry instead of silently
presenting a partial transcript. Details contains session identity, counts and dates;
Metadata contains attributes. Empty sessions still show their root and tabs.

`trace-inspector.tsx` loads the complete span hierarchy from the trace overview
endpoint before rendering the tree or timeline. Virtual scrolling limits mounted
rows, never fetched spans. The overview projects timing, identity, status and
compact metrics without input/output or full metadata for child spans. The first
request includes the visible root's full record so its details render together
with the tree; later overview polling omits that payload. Root selection uses the
shared hierarchy builder in `src/lib/tracer/trace-tree.ts`, including synthetic
roots for multiple or cyclic branches. `trace-detail-loader.ts` caches that root
and loads other selected records within the inspector session; live records
refresh and selection changes cancel stale requests. Span selection immediately
renders the known header and tabs. Payload sections use the shared `Skeleton`
until their data arrives; loading must not look like absent captured data. Read
errors retain the header and tab controls with an inline retry. Root raw JSON and custom
React views in complete-data mode hydrate all payload pages. Input/output-only React
views load the root payload without hydrating child spans or scores. See
[React trace views](./react-trace-views.md) for the sandbox and component contract.
Snapshot inspectors continue to use their frozen evidence without network reads.

## Dataset item links

Dataset inspectors use `/p/[projectSlug]/datasets/[datasetId]/[itemId]`, with
`itemTab` (`form`, `runs`, or `views`) and `objectView` query parameters.
Opening a row, changing its tab or Object View,
and moving between rows add browser history entries; closing returns to the
dataset path and clears only these inspector parameters. Direct links and reloads
render the same dataset table and item inspector. Page View drafts and selection
remain scoped to the dataset path. Links resolve compact item previews within the
current dataset even
when the row is outside the loaded table page. A linked Object View takes
precedence over personal preferences; unavailable links show an explicit error.
These inspector parameters are transient and are excluded from saved Page Views.

The Views picker remains available for rows with omitted payloads. After choosing
a view, **Load and render** fetches the omitted fields together and renders only
when the complete row is available. Failures keep the selection and offer the same
button for retry; changing rows or closing cancels the request. Hydration preserves
existing drafts and the row version checks used by Form.

## Route navigation

`app/(app)/loading.tsx` covers workspace and project-layout loading, so its
`WorkspaceLoading` includes the page header and a viewport-height frame. The
loaded shell and this outer fallback share `WorkspacePageLayout` for route titles,
breadcrumbs and header geometry. The sidebar icon reserves its normal footprint
until the shell supplies the interactive toggle. The nested project `loading.tsx`
uses `ProjectPageLoading` inside the existing shell and must not add a second header.
Both fallbacks compose the lightweight `PageLoading` toolbar and table skeletons
with the same panel padding and control heights as the loaded collection. On the
Traces route, every loading stage also reserves the histogram and count through
`CollectionHistogramSkeleton`. Keep interactive tables, editors and inspectors out
of the fallback import graph; use lightweight presentation components only.

The primary project links explicitly prefetch the full route. Their data
requests still start when the destination mounts, using the page's existing
loading, empty and error states. Keep default partial prefetching for resource
detail links instead of eagerly fetching every row's destination. Verify route
transitions with a production build because automatic prefetching is disabled
in development.

## Adding or changing behavior

`components/ui/scorer-combobox.tsx` owns scorer chips, search, type badges, and the
**New scorer** action inside the popup (enabled by default). Use
`components/tracer/scorer-picker.tsx` for the project catalog, pagination, and
creation link; pass `traceIds` when creating from existing evidence. Playground
and trace selection both use this picker. Section labels belong to the surrounding
layout, and creation must not be duplicated as an external button.

`components/ui/provider-settings.tsx` owns the shared settings page spacing,
provider table, loading and empty rows, and provider picker tiles. Sandbox and
AI provider pages own their credential dialogs, permissions and mutations.

1. Identify the owner above and inspect its current consumers.
2. Add the behavior to that owner when it applies across resources; use composition props for resource-specific differences.
3. Verify initial loading/failure, successful empty results, refresh with retained data, and the affected table/inspector interactions.
4. Update this map when introducing a new shared owner.

Do not migrate specialized screens merely to make their JSX look alike. Trace exploration, dataset editing, eval detail and playground layouts retain their existing shared pieces until a change needs the collection lifecycle. Local Display preferences are shared across collection tables; named saved views and structured filtering remain opt-in resource contracts.

Verification: `bun test tests/collection-page.test.tsx tests/collection-table-cards.test.tsx tests/collection-card-reordering.test.tsx tests/custom-view-table.test.tsx tests/column-webmcp.test.ts`, followed by `bun run typecheck` and scoped ESLint. Browser verification is also required before claiming header portal placement, focus or responsive layout is visually confirmed.

## Reviews

`components/tracer/reviews-page.tsx` owns the review collection, session creation, assignment, and ordered player. It uses `CollectionPage`, the registered `reviews` filter fields, `CollectionTable`, and the existing `TraceInspector`. SDK conversation sessions remain a separate resource. Review instructions and trace order belong to the session; progress comes from saved item reviews. Initial errors never imply an empty collection, and failed score submissions keep the draft in place. The player autosaves edits through a queue per trace and preserves drafts during previous/next navigation. Invalid input stays local; failed saves keep edits available for retry.

`src/server/tracer/reviews.ts` owns the shared REST/MCP service, project membership checks, score attribution and item revisions. See [MCP review workflow](./mcp.md#review-prompts-and-traces) for scopes and input contracts.

Review detail breadcrumbs show the project-scoped review number; the editable title stays in the collection header. That panel keeps Refresh in the menu and Display icon-only. `components/ui/reviewer-combobox.tsx` owns the searchable, controlled reviewer picker with three visible avatars and an overflow count. The header and review forms share it. Review assignments persist through `reviewerUserIds`, with membership validation and session revision checks; the legacy `assigneeUserId` field remains compatible with a single assignment. Skipped trace labels and icons use `text-warning`.

`components/tracer/human-scores-page.tsx` owns the project Human Score library, definition editor, and ordered collections. Human Scores are separate from automated Scorers. Sessions snapshot attached collections; the player shows those criteria on every trace. `HumanScoreInput` uses a slider with a number input, visible `ChoiceCard` radio/checkbox options, or an auto-height text field. Criterion cards keep their title inside the card. `humanScoreIcon` supplies the same type icon to card titles, selected chips, and picker options. Review notes remain above the cards; per-score comments are preserved in saved data without an editor in the player. Reuse the shared `OverlayContainer` when nested popup portals need to remain inside a dialog's focus/pointer boundary.

Selecting traces and choosing Review opens a populated session page immediately, without a creation dialog. `review-session-creation.ts` retains the selected rows while the POST completes; retries reuse a creation key, and the route switches to the assigned session number on success. The session page exposes its Human Score collection directly. Collection changes render optimistically and roll back on failure, preserve saved ratings and notes, and recompute completion. Existing rating definitions stay frozen; item revisions reject drafts from before a collection change.

Review input, output, and custom fields support text annotations through `review-annotations.tsx` and the shared `TextAnnotation` surface. Comments retain the trace/span ID, display format, exact quote, surrounding context, character offsets, and a SHA-256 fingerprint of the captured field value. Selecting a comment restores the span and Overview format; highlights appear only when the field identity, evidence version, and quote anchors match. Changed evidence keeps the original quote visible without silently reattaching it. Comments use the item's revision-protected autosave queue, preserve score completion, and have server-attributed authors. Copied review links include the annotation ID.

Custom-field annotations retain the field ID, definition, displayed value, and source-trace fingerprint. Custom code stays in the browser worker sandbox; the server validates project ownership, the current definition, and source evidence without executing it. The displayed value is a browser-computed snapshot. Linked comments restore their custom fields even when they are absent from that browser's saved field selection. Input and output references retain the existing `outputHash` storage key for compatibility.

Prompt and LLM scorer editors share `components/ui/messages-form.tsx`: role selection,
Mustache/plain-text code editing, and bounded add/remove controls inside an
`InspectorSection` form section. Callers supply supported roles, message limits,
and disabled state. Keep resource-specific persistence and preview behavior in
the page. Use `FormRow` for compact horizontal settings and `InspectorSection`
with `variant="form"` for vertical content, with the editable name in the toolbar.

## Organization settings

`components/workspace/settings-shell.tsx` composes the shared sidebar and `PageLayout`
for General, Members and Billing when given `organization`.
`app/(app)/(organization-settings)/layout.tsx` owns this shell across `/settings/general`,
`/members` and `/billing`; the route group's `loading.tsx` replaces only the page
content, keeping the sidebar and header mounted and interactive. The shell derives
the current title and selected link from the pathname as navigation completes.
General and Members render embedded content inside this layout.
Its header reuses `WorkspaceSelectors`
with the logo, organization search and creation, keeping the current settings page
after an organization switch. The sidebar links between
these organization pages and back to the workspace; embedded project settings keep
their existing outer shell.

`components/workspace/organization-settings-page.tsx` provides General settings at
`/settings/general`. Owners and admins can update the organization name and unique
slug through Better Auth; members see a read-only form. `organizationDetailsSchema`
is shared with the server update hook, while Better Auth enforces membership,
update permission, unique slugs and trusted origins. Saving refreshes the page and
updates the sidebar selector; the organization ID remains stable.

`components/workspace/members-page.tsx` uses `CollectionPanel`, `CollectionPage`,
`CollectionSearch`, and `CollectionTable`. Search filters the fully loaded member list by
name, email, or role. Invite member and Pending invitations open separate dialogs;
errors and retry actions stay in the active dialog. The pending count remains
visible when `PanelActionLabel collapseAt="md"` hides its text below 768px of panel
width. `components/ui/organization-role.tsx` owns role badges and the shared Base UI
role picker, including its portal inside the dialog's focus boundary.

### Organization usage

Organization Usage uses the existing settings shell, cards, notices and table
styles. `DonutProgress` accepts an optional `trackClassName` for a visible
remaining balance and `valueText` for currency-aware accessible labels.
`SegmentedProgress` supports a `dashed` variant for bounded allowance meters;
its existing solid variant remains the default. Use the shared comparison
color tokens with labels to distinguish scorer, sandbox and reserved usage.
Loading, empty, error and exhausted balances remain distinct states. A missing
balance must never look like available credits.

## Public CMS content

`components/ui/content-link.tsx` owns the full-width content navigation row.
`components/ui/content-disclosure.tsx` owns the controlled, keyboard-accessible
answer disclosure with a real link destination for new tabs. CMS components
compose these with the existing Button variants and semantic theme tokens.
`components/cms/faq-accordion.tsx` owns shallow FAQ navigation and related-answer
focus; `page-blocks.tsx` renders complete rich answers in embedded FAQ blocks.
`components/ui/faq-list.tsx` owns the native, keyboard-accessible FAQ disclosures
shared by embedded CMS FAQs and the pricing page.
The Payload admin uses its own UI controls and isolated stylesheet.

### System oversight

`/cms/subscriptions`, `/cms/usage`, and `/cms/organizations/:id` are read-only
custom Payload views. `SYSTEM_ADMIN_USER_IDS` is an explicit subset of
`CMS_ADMIN_USER_IDS`; content editor or organization admin access alone does not
grant cross-organization visibility. Navigation and every server data read enforce
this boundary. These screens use Payload controls and theme variables through
`components/ui/cms-system.tsx` and its scoped stylesheet.
Monthly usage reuses `DashboardTimeChart` with stacked traces/spans. The
`cms-chart.css` bridge scopes dashboard utilities to the chart and imports the
central data palette without applying product resets to Payload. Months with no
retained activity show zero; missing billing counters remain unrecorded.

`cms/system-data.ts` reads a consistent, read-only PostgreSQL snapshot. It does not
call Stripe or the billing synchronizer. Stripe dashboard links are available when
the configured key identifies test or live mode; last-sync timestamps describe
the saved subscription state. Search/filter summaries cover all matches before
pagination. Activity counts retained traces and spans using their own start
timestamps in UTC, including records received before billing was enabled. It uses
the existing project/time indexes and the analytics pool's ten-second query
timeout, reads no payloads, and creates no copies, backfills, or new counters.
Deleted records and records without valid start timestamps are excluded, so these
are retained activity counts, not an immutable ingestion ledger. Empty months show
zero retained records. Billing quota usage separately reads the cumulative
`organization_usage_month` counters, which only accrue while billing is enabled
and are not reduced by deletion. Historical quota percentages are omitted because
plan-limit history is not stored. Organization details show the most recent twelve
months and up to 100 projects. No subscription mutations, customer trace content, or credentials
are exposed by these views.

## Alerts

`components/workspace/alerts-page.tsx` owns the rule catalog and per-alert
notification history. Both use `CollectionPanel`, `CollectionPage`, the shared
filter bar and `CollectionTable`. The bounded rule catalog filters locally; notification
history uses `useCollectionPages` and server filtering before cursor pagination.
`components/workspace/alert-editor-page.tsx` owns the shared new/edit form;
`components/workspace/alert-create-dialog.tsx` uses the dashboard-style dialog and
`RadioCard` choices to select an empty alert or template before navigating to
`/alerts/new?template=<id>`. The form initializes from an allowlisted template ID;
selection does not save a rule. `src/lib/alerts/templates.ts` supplies editable
template defaults. Sidebar links,
parent breadcrumbs and browser titles use the four project-scoped `/alerts`
routes. Owner/admin controls remain separate from member read access.

## Cloud onboarding

`components/ui/plan-label.tsx` owns the compact plan label used by organization
cards and Billing. Core and Pro names come from the shared Cloud plan catalog;
missing subscriptions show **No plan** and billing-disabled installs show
**Self-hosted**. The organization picker reads the stored plan through a
membership-scoped billing join, without making a Stripe request for each card.
The card subtitle shows compact retained trace totals across the organization's
projects, excluding spans. These counts load in one analytics query only when
the organization grid renders, after workspace redirects and onboarding checks.

Direct Cloud sign-ups share the organization form even without a chosen plan.
The organization grid's **New organization** action and the workspace switcher's
**Create organization** action both open `/organizations/new`,
which reuses this two-column form and requires only a signed-in session so an
existing active organization does not redirect it. Cloud creation selects the
new organization and continues to `/pricing`; billing-disabled installations
continue to first-project setup at `/projects`.
After creation, `/pricing` reuses the full public pricing content and opens
checkout for the chosen plan. Its page owns the public or onboarding shell so
navigation cannot retain a stale marketing header. `PricingPlanAction` shares
checkout behavior across the plan cards and comparison table; `OnboardingAccount`
provides sign-out on the setup screens.
`requireActiveOrganization` gates workspace/settings access until subscription
access is confirmed; new organizations resume pricing and existing subscriptions
retain billing recovery. Billing-disabled installations keep the standard flow.

`components/auth/onboarding-shell.tsx` owns the full-screen, responsive two-column
layout shared by billing sign-in, organization setup, and first-project setup.
`components/workspace/onboarding-plan-summary.tsx` shows the chosen plan’s
benefits during sign-in, sign-up, organization setup, and auth loading, without
plan controls. The shared summary includes the Stripe logo in its checkout note.
`public/stripe-logo.svg` is the unmodified white wordmark from
[Stripe’s official logo kit](https://stripe.com/newsroom/information).
Project setup reuses the landing hero’s `RequestStory` from
`components/cms/landing-visuals.tsx` in the right column and hides that column
below the `md` breakpoint, including while loading. It uses the existing project
API directly from its inline form.

## First-trace setup

`components/tracer/trace-onboarding.tsx` uses one shared Card on the canvas
background, with shared Auto and Manual tabs. Both methods retain the same
in-memory API key across tab changes. Auto copies a complete coding-agent prompt
with the current connection settings and generated key; Manual keeps the separate
environment snippet and instrumentation instructions. Clipboard failure leaves
the prompt available to select and copy. The prompt uses the public SDK entry
points and the installation's documentation URLs.
