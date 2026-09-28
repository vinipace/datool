# Datool: inventory of View concepts

**Product decision after this audit:** the canonical features are **Page Views**, **Custom Fields**, and **Object Views**. Page Views combine data selection and all supported page/display settings. Saved queries and value formats are constituent capabilities. See the [full coverage specification](./views-unification.md) for the target behavior; the inventory below describes the audited implementation.

Source audit: 27 September 2026. GitHub main verified as `abf5a4247950ba8dd849f4173a69e685377acaad`. This is a source-level inventory, not a verification of the deployed server or published CLI package.

The calling checkout is clean at older local `main` commit `0abc2d24`. It still contains browser-local React views. To avoid describing retired behavior, this audit used a read-only source export of current GitHub main. No application code, configuration, or production data was changed.

**Finding:** there are five core concepts in this area: computed fields, named table layouts, saved data queries, React record renderers, and built-in value formats. Trace and dataset-item React views are two consumers of one renderer resource. Local table preferences and inspector navigation are additional state, while dashboards are a separate customizable presentation product.

## 1. Cross-surface map

“Absent” means no dedicated registered capability in the audited source. Direct HTTP APIs may still exist.

| Concept | UI | CLI | Server MCP | Browser WebMCP |
| --- | --- | --- | --- | --- |
| Computed field / custom column | Add Column / Add custom field, shared definition picker and editor, table cells and inspector sections | No dedicated command or registered agent operation | No custom-field operations | `list/get/create/update/delete_eval_column`; operates on fields selected in the active table |
| Named table layout | Custom view / Saved views picker on six resource types | Generic `datool agent call list_views\|get_view\|create_view\|update_view\|delete_view`; no dedicated layout command | `list_views`, `get_view`, `create_view`, `update_view`, `delete_view` | No saved-layout CRUD/select tools; column/order tools can change a layout draft |
| Saved query / selector projection | Client API helpers exist, but no active product UI consumer or dedicated view route was found | `datool views list\|get\|data\|resolve`; writes through `agent call *_saved_view` | `list_saved_views`, `get_saved_view`, `create_saved_view`, `update_saved_view`, `delete_saved_view`, `get_saved_view_data`, `resolve_view` | Absent |
| React record renderer | Views tab in trace inspector and dataset-item inspector | No dedicated command or registered agent operation | Absent | `list_trace_views`, `get_trace_view`, `create_trace_view`, `update_trace_view`, `select_trace_view`, `delete_trace_view` |
| Built-in value format | Image, LLM, LLM Raw, JSON, YAML, Text, Pretty, Tree; dataset Display → Field views | No format-selection command | No format-selection operation | No format-selection tool |

**The naming collision:** CLI `views list` invokes `list_saved_views`, whereas MCP `list_views` reads `custom_views`. Browser `list_trace_views` reads `react_views`. Asking an agent to “create a view” can therefore target three unrelated persistence models.

The server MCP and generic CLI agent calls share one operation catalog. Browser WebMCP has its own registration and schemas. React/custom-field HTTP endpoints are not automatically exposed through that catalog.

Evidence: [CLI aliases](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/bin/agent.ts#L111), [server view operations](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/mcp/operations.ts#L231), [React browser operations](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/use-react-view-webmcp.ts#L60), [MCP registration](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/mcp/server.ts#L15).

## 2. Computed fields / custom columns

**Meaning:** reusable JavaScript expressions or templates that compute a displayed value from a row. These do not change captured trace data or dataset ground truth.

- Type: `ComputedColumn { id, name, code, mode, format? }`.
- Modes: `expression`, `template`; template expressions use `{{ ... }}`.
- Formats: `text`, `markdown`.
- Definition storage: project-scoped PostgreSQL `custom_fields`.
- Selection/order: browser/table state, with full definition copies in some local stores and saved layouts.
- Execution: bounded browser worker; no server formula execution.
- Lifecycle: list and save/upsert. Editing overwrites the shared definition. Removing a column only removes that table's selection. There is no registry delete/archive or revision-checked field update contract.
- Names are case-insensitively unique within a project. Matching definitions can reuse an existing ID.
- API: `GET /api/custom-fields`; `POST /api/custom-fields` with `{ field, overwrite? }`.
- Permissions: `views:read` / `views:write`.

Consumers include trace lists and inspector custom-field sections, eval-run rows, playground traces, dataset rows, Agents/Workflows aggregate tables, and review playback. Review playback reuses the trace field selection.

The same field library spans three input shapes:

| Context | Formula input |
| --- | --- |
| Trace / eval / playground | Flattened trace fields plus `row.trace`, `row.input`, `row.output`, `row.results`, expected-output context and metrics |
| Dataset item | `row.input`, `row.expectedOutput`, `row.metadata`, plus dataset-item fields |
| Agent/workflow aggregate | `row.name`, `row.groupType`, aggregate `row.metrics` |

There is no field target-kind or requirements contract comparable to React views. A field can be available in a context where its expression cannot run.

WebMCP uses the legacy `eval` names and `runId` argument even for traces, datasets, playgrounds and performance tables. The scope must come from `list_eval_columns`. Ordering tools are `get_eval_column_order`, `move_eval_column`, `swap_eval_columns`, `reorder_eval_columns`. They include built-in and computed column IDs, but exclude fixed selection/Add Column controls. The tools are registered by the active `LogTable`; a review-only custom-field section does not itself register them.

Evidence: [field contract and adapters](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/computed-columns.ts#L1), [field service](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/tracer/custom-fields.ts#L1), [browser tools](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/column-webmcp.ts#L169).

## 3. Named table layouts versus local table preferences

**Meaning:** reusable table presentation settings, stored as `CustomView` in `custom_views`, with IDs beginning `cview_`.

Saved settings include schema version 1, up to 50 complete computed-column definitions, column order, visibility, width, table/cards mode, compact/tall row height, and Details-panel open state.

They do **not** include the collection filter/search query, sort, selected rows, comparison run, or React renderer selection. `fieldViews` exists in local `LogTableSettings` but is absent from the saved-layout schema.

| Surface | Named database layout | Local display settings | Computed fields |
| --- | --- | --- | --- |
| Eval-run detail | Yes: `eval-runs` | Yes, scoped by project/run | Yes |
| Playground trace table | Yes: `playground-traces` | Yes, keyed by connection | Yes |
| Agents table | Yes: `agents` | Yes | Yes |
| Workflows table | Yes: `workflows` | Yes | Yes |
| Scorers table | Yes: `scorers` | Yes | No computed-field adapter passed to `useTableView` |
| Prompts table | Yes: `prompts` | Yes | No computed-field adapter passed to `useTableView` |
| Traces collection | No resource configured | Yes | Yes |
| Dataset-item table | No resource configured | Yes, including field formats | Yes |
| Playground app collection | No resource configured | Yes | No |

Other tables use the shared local Display settings without a named layout resource: sessions, eval-run collection, review-session collection, review-session items, dashboard collection, Human Scores/collections, and dataset-item run history. This is the same local presentation mechanism, not another saved-view entity.

Persistence/lifecycle:

- The current named layout is shared within a project, across browsers.
- Updates/deletes use `expectedRevision`; stale writes return a conflict.
- The latest 50 versions observed by a browser are stored in localStorage, not a database version-history table.
- UI updates require preserving the old revision locally; generic API/MCP updates do not create browser history.
- Restore writes the old snapshot as a new revision.
- Eval detail carries selection in `?view=<id>`; other named-layout consumers use the hook's component state for selection.
- API: `/api/custom-views` and `/api/custom-views/:id`.
- All six resources share the eval-named `evalViewSettingsSchema`.

**Confirmed discovery gap:** MCP `list_views` accepts no resource parameter and always calls `customViews.list("eval-runs")`. Create/update accept all six resources through the shared input schema. An agent can create a Prompts layout that this list operation will never return.

Evidence: [saved schema](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/custom-views.ts#L17), [layout adapter](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/use-table-view.ts#L21), [UI history and save flow](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/custom-view-controls.tsx#L144), [MCP list restriction](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/mcp/operations.ts#L231).

## 4. Saved queries / selector projections

**Meaning:** stored selection and projection of data, executed on the server. Type `SavedView`, database `saved_views`, default IDs beginning `view_`.

- Resources: `traces` or `eval-results`.
- Columns: `{ id, label, selector, format }`; formats boolean/json/number/text.
- Filters: selector plus `equals`, `notEquals`, or `exists`.
- Sort: selector plus asc/desc.
- Selectors are restricted dotted paths, with array indices and no arbitrary JavaScript or bracket notation.
- Trace queries expose the `trace` root. Eval-result queries expose `trace`, `datasetItem`, `evaluator`, and `result`.
- Query execution compiles these selectors into PostgreSQL JSON extraction and returns bounded projected rows, not rendered UI.
- Eval-result queries can additionally be restricted to a run ID.
- API: `/api/views`, `/api/views/:id`, `/api/views/:id/data`.
- No revision/CAS field, shared revision history, width, layout, or React source.
- The resolver targets `saved_views` and returns the Traces collection URL; it does not open/apply the saved query in the UI.
- CRUD permissions: `views:read/write`. MCP data execution additionally requires both `traces:read` and `evals:read`.

This feature still has service, API, CLI/MCP and test coverage even though its UI client helpers have no active product consumer in the audited source.

Evidence: [SavedView types](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/contracts.ts#L324), [query execution](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/tracer/saved-view-sql.ts#L13), [persistence](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/tracer/service.ts#L2590), [resolver](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/tracer/agent-foundations.ts#L568).

## 5. React record renderers: traces and dataset items

**Meaning:** a shared project library of custom TSX components. Type `ReactView`, database `react_views`, IDs beginning `rview_`.

A definition contains name, description, code, data mode, nullable requirements, revision, project ID, immutable author/origin, and timestamps. The origin records where the view was created; it does not restrict reuse to that source.

Both inspectors use `ReactTraceViews`, and code receives `ViewProps { trace }`.

| Input | Trace inspector | Dataset-item inspector |
| --- | --- | --- |
| `trace.input` | Recorded trace input | Current form input, including valid unsaved edits |
| `trace.output` | Recorded output | Current **expected output** |
| `trace.attributes` | Trace attributes | Current metadata |
| `trace.spans` / `trace.scores` | Available in full mode; omitted in summary mode | Empty arrays in the adapter; omitted in summary mode |
| ID / operation | Actual trace | Dataset-item ID / `dataset-item` |
| Source trace | Actual record | Origin metadata only; its output is not fetched as the preview output |

Consequently, “dataset React view” is not a distinct type or library. It is an adapter into the trace renderer contract. Expected output, observed execution output, and source-trace output must remain explicitly distinguishable in any redesign.

Rendering:

- `summary`: root data without child spans/scores; `full`: detailed trace payload.
- New UI views start in summary mode; the API schema defaults omitted dataMode to full.
- Imports: React, `@datool/ui`, `@datool/charts`; static Tailwind support.
- Compilation happens in a worker with cached artifacts. Rendering uses an iframe sandbox with network access blocked.
- UI and WebMCP compile before saving. The HTTP service validates the resource schema and persists source; it does not compile/render it server-side.
- Compilation, compatibility, and successful rendering are separate claims.

Compatibility:

- JSON Pointer requirements include type, required and nonEmpty.
- `null` = not reviewed; `[]` = reviewed with no specific field requirements.
- Picker sorts met → unknown → missing, with origin affinity as a tie-breaker; all remain selectable.
- UI does not offer requirement editing or a description input.
- Code/data-mode edits clear requirements in UI/WebMCP unless an explicit reviewed contract is supplied.
- The direct update API requires a complete input; the service does not infer whether reused requirements remain valid.
- `POST /api/react-views/suggest` proposes requirements from static field access and a sample; suggestions need review. It has no dedicated MCP/WebMCP/CLI tool.

Lifecycle:

- Project database stores definitions; one local selected ID per project is shared between trace and dataset contexts.
- Reads are paginated metadata without code; get returns full code.
- Update/delete use `expectedRevision`. There is no persisted renderer revision-history/restore API.
- Creating/copying captures the current record as origin; unsaved new dataset items use null source.
- API: `/api/react-views`, `/api/react-views/:id`, `/api/react-views/suggest`.
- WebMCP is registered in the app shell for the project. `select_trace_view` selects locally; preview occurs when a Views tab is open.
- Permissions: `views:read/write`; origin capture also requires read permission for the source.

The old `datool:react-trace-views` browser-local definition store was removed from current main. Its definitions were retired without migration. It remains in the older calling checkout and must not be mistaken for current-main persistence.

Evidence: [contract](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/react-views.ts#L35), [shared UI](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/react-trace-views.tsx#L52), [dataset adapter](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/dataset-item-view.ts#L1), [service](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/server/tracer/react-views.ts#L1), [runtime contract](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/trace-view-contract.ts#L1).

## 6. Value formats and adjacent concepts

**ValueView** is the enum Image / LLM / LLM Raw / JSON / YAML / Text / Pretty / Tree. These are built-in representations of one value, with availability checks and fallback selection. They contain no user React code, ID, shared library, or revision.

Dataset table `fieldViews` stores a format per input/expectedOutput/metadata field and also drives the form inspector. Generic structured viewers can keep their selection in component state. This is separate from computed-field text/markdown formatting and saved-query boolean/json/number/text formatting.

Other relevant concepts:

- **Review evidence references:** annotation `reference.view` is a ValueView enum. Custom-field annotations capture the definition, computed value and source hash. These are immutable evidence context, not another live view definition.
- **Inspector modes/tabs:** overlay/page/panel; Trace/Evaluators/Timeline/Views; Messages/Details/Metadata/Raw; dataset Form/Runs/Views. These are navigation/presentation state.
- **Dashboards:** another project-shared configurable visualization resource. They store semantic queries and widget layout, with metric/bar/donut/table/stacked/line renderers and revision checks. UI, CLI `dashboards`, and MCP dashboard CRUD/preview exist. They are outside all three view stores, with no dedicated browser WebMCP tools.
- **Dataset schemas:** JSON schemas for source fields are data validation, separate from computed fields and display formats.
- **Reports:** the additional MDX/frozen-report work is on a separate local branch; it is not part of the verified main snapshot and is excluded from this inventory of main.
- CMS system views, Next routes, Monaco view state, and database internals are not end-user custom views.

Evidence: [value formats](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/value-views.ts#L6), [annotation contract](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/review-annotations.ts#L20), [dashboard contract](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/src/lib/tracer/dashboards.ts#L24).

## 7. Issues the lasting fix needs to address

These are findings from source inspection. Risks described below have not been reproduced against production.

1. **Vocabulary and discovery diverge.** Three meanings of “views” across CLI/MCP/WebMCP; `eval` names for generic fields; `runId` for arbitrary table scope.
2. **Capability parity is incomplete.** React views and field definitions have HTTP/UI/browser access but no server-agent operations. Table-layout discovery omits five supported resources. Saved queries have agent support but no active UI.
3. **Layout application can write shared field definitions.** `applyView` passes embedded definitions to `computed.store.update`; the persistence callback sets `overwrite=true` when an already-selected field differs. Thus switching/restoring an old layout can overwrite a shared field. If that field was not already selected, the registry's existing definition wins instead. The result depends on prior selection, not just the chosen layout.
4. **Layout application is not atomic.** It discards the async computed-field update promise, then applies order/settings and marks the selected layout. Failure can leave partial application.
5. **Browser project scoping is inconsistent.** Some stores use organization/project scope, others use global keys such as trace field/order selection. The field registry and one-time migration promise are module globals; migration scans all `datool:eval-columns:` keys without filtering project ownership. These paths need explicit project-switch/isolation regression coverage.
6. **The saved-layout contract is incomplete.** Field formats, filters and sorting are outside it; trace/dataset tables cannot save named layouts despite having the shared display infrastructure.
7. **Shared-resource lifecycle differs.** Field definitions and saved queries have no CAS revision; table/React views do. Layout history is browser-only; React history is absent. Server writes bypass the UI's layout-history preservation.
8. **Input contracts are implicit.** Computed fields have heterogeneous row shapes; dataset React rendering repurposes trace fields. The three path mechanisms are JS expressions, dotted selectors, and JSON Pointers.
9. **Documentation is stale in places.** `docs/custom-views.md` still says only eval-runs are accepted; `docs/computed-column-webmcp.md` still describes definitions as browser-local. Several UI/tool strings also retain the older local/eval wording.

Evidence for 3–5: [layout application](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/use-table-view.ts#L62), [field persistence callback](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/use-computed-columns.ts#L15), [global registry/migration](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/custom-field-registry.ts#L6), [trace storage keys](https://github.com/vinipace/datool/blob/abf5a4247950ba8dd849f4173a69e685377acaad/components/tracer/trace-list.tsx#L86).

## 8. Agreed product names and full coverage

| Canonical name | Responsibility |
| --- | --- |
| Page Views | Save complete supported page state: query, filters, sorting, fields, formats, density, layout, panels and display defaults |
| Custom Fields | Persist reusable computed values with explicit object compatibility for every product data table/card |
| Object Views | Persist custom React presentations of traces and dataset items, wherever those objects appear |

Saved queries become the query portion of Page Views. Value formats become display settings. The implementation scope, surface matrix, interface parity, persistence rules, migration requirements and acceptance checks are defined in the [full coverage specification](./views-product-spec.md). This supersedes the earlier Collection view / Record view naming recommendation.

Existing tests provide starting points: `react-views.test.ts`, `dataset-item-view.test.ts`, `custom-fields.test.ts`, `custom-views.test.ts`, `custom-view-table.test.tsx`, `table-settings-store.test.ts`, `column-webmcp.test.ts`, `column-order-webmcp.test.ts`, `eval-column-storage-isolation.test.ts`, `mcp.test.ts`, `cli-agent.test.ts`, and the React-view browser E2E harness.

This pass inspected their coverage; it did not execute tests, alter the implementation, or verify deployment.
