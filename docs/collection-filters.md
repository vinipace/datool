# Collection filters

Traces, eval runs and sessions use `CollectionFilterBar`, backed by the same field catalog and parser as their list APIs. Filter expressions are sent as the `filter` query parameter on `GET /api/traces`, `GET /api/evals` and `GET /api/sessions`. Use `URLSearchParams` to encode them.

```ini
"search text"
"payment failed" status = 'errored'
metadata."ai.model.id" = 'gpt-4o-mini' output.role = 'assistant' metrics.time_to_first_token < 3
name contains 'launch' status = 'completed' durationMs >= 100
metadata.cohort = 'regression' score >= 0.8
traceCount > 1 attributes.source = 'sdk'
```

Adjacent comparisons are ANDed. Operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, and `contains` (case-insensitive substring for strings; equality for other scalar values). The keyword `contains` is lowercase and separated from its value by whitespace. Existing `:` expressions remain supported as an alias; suggestions and chip edits use `contains`. Both single and double quotes are supported; escape quotes and backslashes with `\`. Quote path segments containing literal dots: `metadata."ai.model.id"` accesses one key, whereas `metadata.ai.model.id` traverses three keys. Array indices use dotted segments, such as `output.messages.0.role`.

A standalone quoted phrase performs case-insensitive substring search across the resource's registered text and enum fields and all nested string values in its JSON fields, including arrays. JSON keys, numbers, booleans, nulls, dates and unregistered fields are excluded. Multiple phrases and field comparisons are ANDed; each phrase can match a different field. Quotes, backslashes, `%` and `_` are literal search text, not wildcards. Single quotes also work. Empty phrases are invalid. A quoted field followed by an operator remains a field comparison, such as `"name" = 'launch'`. Trace search covers the trace's registered fields and every descendant span's ID, name, kind, group fields, status, input, output and attributes, at any nesting depth. A matching span includes its trace once, before pagination and totals; separate phrases may match different spans of the same trace. Structured comparisons still target their existing fields. Dashboard trace filters use the same match and retain all otherwise eligible spans of a matching trace, independently of when the matching span started. Agents and workflows search name and version.

Numbers, booleans and `null` are typed values; quote numeric strings to compare them as strings. Missing paths never match, including `!= null`. Dates use quoted ISO dates or rolling relative durations (`-1h`, `-24h`, `-3d`, `-7d`; units: minutes, hours, days, weeks), ordered numeric comparisons do not coerce strings, and duration fields are milliseconds. OR, grouping, arbitrary code and SQL are not supported. Invalid expressions return HTTP 400 with `VALIDATION_ERROR`, even on an empty collection. Limits: 4,000 characters, 50 clauses and 20 path segments.

For traces and sessions, `metadata` aliases the stored `attributes` object. For traces, `metrics` aliases `attributes.metrics`; it does not infer metrics from spans or convert units. In the first example, `< 3` uses the captured metric's units. Eval `metadata` refers to the eval run's own metadata. Available fields and enum values are defined in `src/lib/tracer/collection-filters.ts` and drive both suggestions and validation.

The UI keeps typing in a local draft. Select a suggestion or press Enter to submit it; tabbing away or blurring never applies a draft. Every nonempty draft offers a full-text search option, including arbitrary words or incomplete expressions. A complete valid expression also offers **Add filter**, and selecting a registered value submits that comparison. Drafts show no validation errors and do not change results, counts or requests. Applied changes use the existing 350 ms debounce; clearing applies immediately. Each applied filter resets pagination. The shared fetch hook isolates requests by filter, discards stale responses, and refreshes the loaded cursor chain. Evals and sessions also expose Load more. Trace time and status are expressions in the same bar, with no separate display filters. Traces initially use `startedAt >= -3d`; their date filter is fixed but editable. Clearing the bar preserves the selected date range and removes the other filters. Relative cutoffs are resolved once per backend request and refresh as time passes.

## Reuse on another page

1. Add a field catalog entry to `collectionFilterFields`. Add any resource-specific aliases in `compileCollectionFilter`.
2. Accept `filter` in the list endpoint and pass it to the service. Compile once with `compileCollectionFilter(resource, filter)` and apply the predicate **before** pagination and totals. Convert parser failures to the API's validation error.
3. Use `useCollectionFilter(resource)` and pass its returned state to `CollectionFilterBar`. Feed its `filter` into `useCollectionPages(list, filter)`. The list function accepts `filter`, `cursor`, and `limit`; `CollectionPagination` renders the load-more control.

Submitted expressions become bordered, interactive chips (for example, `startedAt >= -3d` becomes **Past 3 days**). Full-text chips are amber, dates blue, enums purple, JSON cyan, numbers green and text comparisons indigo; the theme owns these colors. Click a chip to edit it, or its remove button to delete that clause. Pages can pass `fixedFilters` (field names and default expressions) to keep required filters present. These chips have no remove button and retain their current values when other filters are cleared or replaced. Initial queries missing a required field receive its default expression. The trailing combobox adds clauses while the existing chips stay visible. Editing or removing a chip preserves unsubmitted text; loading another saved query replaces the draft.

The bar keeps one full-text search chip. Submitting new text replaces the previous phrase in place and preserves date and structured comparisons, including quoted field values. If a submitted expression includes several standalone phrases, the last one wins. The API grammar continues to accept multiple ANDed phrases for programmatic queries.

Suggestions span the full bar width and scroll within a height capped at 20rem or the available viewport space. Each option has a search or filter icon, and structured expressions use syntax highlighting. Chips use the shared `rounded-sm` radius.

The bar reserves a fixed 40px row in the layout. When unfocused, overflow is clipped to that row. Focusing the input or a chip expands the bar over the page, without moving the header or content. It stays expanded while a chip editor is open, and suggestions follow the expanded bar. Long expanded filters scroll within 20rem or half the viewport height.

Full-text chips and string comparisons edit only the literal text, with quotes and backslashes escaped automatically. Comparison editors show a syntax-highlighted field and operator label, such as **Group Name contains**, and preserve the field path and operator when updating the value. Enum chips offer an operator and registered values. Date chips offer rolling presets and a custom range in the browser's local time zone, serialized to UTC. Adjacent `>=` and `<=` bounds for the same date field share one custom-range chip; replacing or removing it updates both bounds. Other chips expose the original expression and validate it before applying. Editors use compact Update and Remove text buttons; fixed filters omit Remove. Popovers support Tab, Enter and Escape and return focus to their trigger.

`SearchBar` itself opts into this grammar with `syntax="filter"`. Its default search syntax and existing table behavior remain available. Highlighter configuration is scoped to each editor instance.

## Execution boundary

Paginated collections compile filters to parameterized PostgreSQL predicates before pagination and totals. Shared trace filters also apply before chart aggregation, including quoted full-text search. JSON search uses decoded string values so escaped quotes and backslashes match the same way as local predicates. Fully loaded local collections use `compileCollectionFilter` with the same field catalog and matching rules.

## URL persistence

Page-level collection filters use the `filter` query parameter, including full-text search and relative or absolute date clauses. Valid edits replace the current URL after the search debounce, preserving other query parameters and the hash. Reloading, opening a shared link, and browser Back/Forward restore the filter. Relative dates remain relative when reopened.

Without `filter`, the page uses its default (for example, a dashboard's default date window). An explicit `?filter=` means the user cleared the filter and overrides that default. Nested pickers and dialogs pass `{ persist: false }` to `useCollectionFilter` so their temporary searches do not change the page filter.

## Trace and span names

`traceOrSpanName = "Generate"` matches the trace name or any descendant span name exactly. `traceOrSpanName contains "generate"` performs a case-insensitive substring match limited to names; input, output and attributes are excluded. Matching spans include their trace once, before pagination and totals. `!=` excludes a trace if any name equals the value. `startedAt` still filters the trace start time.

Horizontal cost/usage bars link to Traces with the chart date range and supported trace filters. LLM-call charts use `functionName =`, matching the same function attribution as the chart (telemetry function IDs and ancestor function/agent fallbacks). Span-name charts use `traceOrSpanName =`; request-name charts use `name =`. These links find related traces by name, not individual cost contributions. Unsupported scopes and unnamed rows remain unlinked instead of dropping filters.
