**Datool views — product specification and full coverage**

Status: product specification; implementation is in progress in the [delivery ledger](./views-progress.md). Canonical names supplied by the user: **Page Views**, **Custom Fields**, **Object Views**. This supersedes the proposed vocabulary in the [source inventory](./views-inventory.md). The inventory describes the implementation before this work; this document defines the intended full coverage.

**1. Product model**

| Feature | User purpose | Database-owned definition |
| --- | --- | --- |
| Page Views | Return to a page with the same filtering, sorting, and presentation | Page type, resource context, complete supported page settings, and references to Custom Fields/Object Views |
| Custom Fields | Compute information once and display it wherever the supported object type appears | Name, formula, typed result, supported object types/input contract, default formatting, versions |
| Object Views | Understand a trace or dataset item through a custom React presentation | Name, React source, supported object types, required data, data-loading contract, versions |

A Page View combines data selection and presentation. Saved queries and table layouts become implementation inputs to Page Views. They are not separate user-facing libraries. JSON/YAML and similar formats are settings on fields/values within Page Views or Object Views, not another resource family.

Relationship: Page View → filter/sort/display settings + Custom Field references + optional default Object View references. Custom Fields and Object Views remain reusable project resources. Applying a Page View never edits their definitions.

**2. Page Views: complete saved page state**

A saved Page View must capture every supported page preference:

| Category | Included state |
| --- | --- |
| Data selection | Search, structured filters and boolean combinations, selected agents/workflows/versions, dataset/run context, date range |
| Time behavior | Relative versus absolute range, timezone where configurable; “last 7 days” remains relative on reopen |
| Ordering | Sort fields, direction, precedence, null handling, grouping where supported |
| Columns/fields | Built-in and Custom Field selection, order, hidden columns, widths, pinning where supported |
| Value rendering | Per-field JSON/YAML/Text/Markdown/Image/LLM/LLM Raw/Pretty/Tree where applicable; compatible formats depend on the value |
| Density and layout | Compact/tall rows, table/cards mode, wrapping/truncation, card field selection/order, supported sizing |
| Panels/navigation | Details-panel preference, supported panel size, relevant tabs, tree/group expansion settings |
| Data presentation | Page size, refresh preference, comparison configuration where supported |
| Object presentation | Default Object View by object type, including distinct defaults for traces and dataset items |

This requires capturing controls that exist on a surface. It does not require adding every possible control to every page. A central capability definition lists supported settings; unsupported or obsolete settings are reported, not silently dropped. New preference controls must participate in the Page View contract.

Transient execution state is not a preference: current pagination cursor, request loading/error flags, focused DOM element, scroll position, active bulk selection, and unsaved dataset edits are excluded. Specific record links can include record identity separately from the Page View ID.

A Page View has a stable URL and can be reopened, copied, renamed, updated, deleted, and restored from history. Reopening uses the latest saved revision unless a revision is explicitly pinned. A missing/inaccessible referenced dataset, run, field, or Object View produces a recoverable explanation and retains the saved configuration.

Named Page Views are shared project resources, consistent with existing saved layouts. Durable personal defaults are separate database-backed preferences, scoped by project, principal and context. Page View selection and unsaved working drafts remain in scoped local storage until the user explicitly saves or resets them. Auto-saving personal preferences must not overwrite a shared Page View.

Editing produces a draft with a visible unsaved state. “Save changes” updates the selected Page View; “Save as new” creates a copy; “Reset” reloads the saved definition. Resolving and validating dependencies must complete before the UI reports the Page View as applied.

**3. Custom Fields: reusable across all product data tables**

Custom Fields persist in the database and are bound to supported object types, not to a particular page or browser. A trace-compatible field works in trace tables, cards, evaluations, reviews, playgrounds, session trace lists, and dataset-item run history. A dataset-item field works anywhere dataset items are shown.

Each definition includes:

- Stable ID, name, description, author, timestamps, schema version and revision.
- Supported object types and input requirements.
- Expression/template source, typed output, null/error behavior and default display format.
- Explicit evaluation limits and supported query operations.
- Version history and reference/dependency information.

Values remain typed until formatting: a numeric field sorts as a number; false, zero, empty, missing, and evaluation error are distinguishable. JSON/YAML can format structured field output; Markdown can format text. Page Views may override presentation without modifying the field definition.

Tables and cards use the same evaluation contract. A details section may also expose the same computed fields. A field must not depend on browser DOM, the currently loaded page of results, or privileged data absent from its declared input.

Every product data table must register an object/row adapter. Mixed rows such as an eval result expose named context (trace, dataset item, result) rather than flattening unrelated fields unpredictably. Aggregate rows declare their aggregate input type. Unsupported fields stay discoverable with an explanation; they must not fail silently or make unrelated tables unusable.

Creation, editing, preview/evaluation, copy, deletion, dependency inspection, history and restore must be available through the shared service and all four interfaces. Removing a field from a Page View removes its reference, not the shared field. Deleting a referenced field must be dependency-aware; do not silently cascade changes into other Page Views.

A Page View normally refers to the current shared field by ID. The reference contract also supports a pinned revision. Page View history records resolved dependency revisions so restoration can reproduce the old field behavior without overwriting the field library.

Custom Field filtering/sorting must have explicit capabilities. A queryable field must produce the same result in UI and headless reads and operate over the complete filtered record set before pagination. Browser-only filtering/sorting of loaded rows must never masquerade as a saved full-dataset query. The implementation must provide a bounded evaluator/query strategy or explicitly reject an unsupported operation in every interface.

**4. Object Views: custom presentation of traces and dataset items**

An Object View is a reusable React presentation of an object. Traces and dataset items are required targets. The same Object View can support both when it explicitly declares compatible inputs.

Use an honest typed input envelope, conceptually:

```ts
type ObjectViewInput =
  | { kind: "trace"; object: TraceViewData; context: TraceContext }
  | { kind: "dataset-item"; object: DatasetItemViewData; context: DatasetItemContext }
```

Exact type names remain implementation details. Required semantics:

- Trace input/output are recorded execution evidence.
- Dataset input, expected output, metadata, observed output and source references remain distinct.
- A dataset preview uses valid current form drafts and identifies that they are unsaved. Invalid drafts produce validation feedback.
- A view does not fetch a source trace merely to substitute its output for expected output.
- Summary/full or equivalent requirements specify which evidence is loaded. Missing, unavailable, truncated, and loading data are distinguishable.
- Compatibility is separate from compilation and actual rendering success.
- Origin is provenance, not an implicit restriction on reuse.

Object Views support name/description, code, object types, explicit requirements, runtime version, author/origin, revision history, and default selection by user/page/object type. A Page View can override that default. Selecting a dataset Object View must not unexpectedly replace the user's trace default.

Preserve existing sandboxing, supported shared components, charts and static Tailwind. Expose a documented read-only path to resolved Custom Field values if an Object View needs them; dependency revisions and failures remain visible.

“Control” means the user can author the presentation and interact locally with its controls. Rendering must not silently mutate traces, dataset ground truth, reviews, or shared definitions. Existing authenticated product actions can remain outside the sandbox; adding record-writing actions inside Object Views is a separate explicit contract.

UI editing provides preview, diagnostics, requirements editing, copy, save, delete, history and restore. CLI/MCP/WebMCP can manage the same definitions and request equivalent validation/preview results. A headless preview must use the real sandboxed renderer or explicitly report that rendering was not executed; saving source or compiling alone is not render verification.

**5. Coverage by product surface**

“Yes” is required target coverage, not a claim about current implementation. All rows receive Page View settings appropriate to their surface and Custom Fields backed by typed row adapters.

| Surface | Page Views | Custom Field input | Object Views |
| --- | --- | --- | --- |
| Traces collection/table/cards | Yes | Trace | Trace inspector/full page |
| Standalone trace inspector | Page/display preferences | Trace | Trace |
| Sessions collection | Yes | Session summary | Trace objects reached through the session |
| Session trace lists/details | Yes | Trace plus explicit session context | Trace |
| Eval-run collection | Yes | Eval-run summary | Trace/dataset objects reached from a run |
| Eval-run rows and comparisons | Yes | Eval result + trace + dataset context | Trace and dataset item |
| Dataset library | Yes, including supported folder/tree settings | Dataset/library-entry metadata | Dataset items reached from a dataset |
| Dataset-item table/cards | Yes | Dataset item | Dataset-item inspector |
| Dataset-item run history | Yes | Trace/result | Trace; retain dataset context |
| Playground app collection | Yes | App/connection metadata | Trace objects reached from an app |
| Playground trace tables/cards | Yes | Trace | Trace |
| Agents / Workflows tables | Yes | Typed aggregate row | Trace drilldown |
| Review-session collection | Yes | Review-session summary | Trace objects reached from a review |
| Review playback/items | Yes | Trace + review-item context | Trace |
| Prompts / prompt versions tables | Yes | Prompt/version metadata | Trace objects where linked |
| Scorers / scorer versions tables | Yes | Scorer/version metadata | Trace/dataset objects where linked |
| Human Scores / score collections | Yes | Definition/collection metadata | Trace/dataset objects where linked |
| Dashboard collection | Yes | Dashboard metadata | Trace/dataset drilldowns |
| Table widgets, alert lists, and other product data tables | Yes where tabular data is exposed | Explicit typed row adapter | Trace/dataset objects where linked |

“All tables” is an infrastructure rule: shared table/card primitives provide Page View and Custom Field integration, including tables that currently use bespoke components. New tables must declare their data adapter and capabilities. Any exception must be explicit in the coverage registry.

This scope does not turn a dashboard configuration into an Object View, or require React Object Views for every administrative entity. The required Object View targets are traces and dataset items. Source-data permissions continue to apply to fields and views; a row adapter cannot expose hidden credentials or unauthorized records.

**6. Full UI / CLI / MCP / WebMCP coverage**

Use one server operation catalog and shared schemas for common resource operations. Browser WebMCP wraps those operations and adds explicit controls for the active page. Discoverability must list every supported resource and capability, with pagination.

| Capability | UI | CLI | MCP | WebMCP |
| --- | --- | --- | --- | --- |
| List/search/get all three resource types | Yes | Yes | Yes | Yes |
| Create/update/copy/delete | Yes | Yes | Yes | Yes |
| Validate input/compatibility/dependencies | Yes | Yes | Yes | Yes |
| Revision conflicts/history/restore | Yes | Yes | Yes | Yes |
| Read/query Page View results | Page rows | Bounded data result | Bounded data result | Same result + active-page context |
| Preview/evaluate Custom Field | Sample/table | Typed values + diagnostics | Same | Same + current records |
| Validate/preview Object View | Sandboxed preview | Shared preview result/artifact | Same | Same + active inspector |
| Set durable personal preference/default | Yes | Yes | Yes | Yes |
| Open Page View in an active UI | Navigate/apply | Resolve/open link where supported | Resolve link | Navigate/apply |
| Inspect/change unsaved active-page draft | Yes | No implicit browser access | No implicit browser access | Yes |

Recommended unambiguous names:

| Resource | HTTP | CLI namespace | Shared operation family |
| --- | --- | --- | --- |
| Page Views | `/api/page-views` | `datool page-views` | `list_page_views`, `get_page_view`, `create_page_view`, `update_page_view`, `copy_page_view`, `delete_page_view` |
| Custom Fields | `/api/custom-fields` | `datool custom-fields` | `list_custom_fields`, `get_custom_field`, `create_custom_field`, `update_custom_field`, `copy_custom_field`, `delete_custom_field` |
| Object Views | `/api/object-views` | `datool object-views` | `list_object_views`, `get_object_view`, `create_object_view`, `update_object_view`, `copy_object_view`, `delete_object_view` |

Each family also exposes history/restore and validation. Specific operations include `get_page_view_data`, `evaluate_custom_field`, `preview_object_view`, and the relevant resolvers. A scoped preferences operation supports the same defaults through every interface.

Browser-only helpers include `get_page_view_context`, `apply_page_view`, `update_page_view_draft`, `save_page_view_draft`, and `select_object_view`. Inputs identify page/object/project context explicitly; generic field operations must no longer pretend every table is an eval run.

Headless clients do not acquire implicit control of someone else's open browser. They can save definitions/defaults and resolve links; browser WebMCP applies the same resources to its own active page.

**7. Persistence, revisions, ownership and execution**

- PostgreSQL is authoritative for definitions, immutable revision history, and durable user preferences.
- All shared updates/deletes use expected revisions. Restore creates a new revision.
- Project and user scoping must be explicit across queries, caches, pending requests, browser events, local keys and migrations.
- Page Views contain references and display/query settings, not writable copies of field or Object View definitions.
- Applying a Page View resolves/validates dependencies first and updates the page coherently. Failure preserves the previous usable state and the draft.
- Shared-definition saves, personal preference saves, and page application are distinct operations with distinct results.
- Compile/evaluate/query/render limits and error semantics are consistent across clients. Keep bounded pagination and data-access permissions.
- Editing a Custom Field or Object View creates a new shared revision; current versus pinned references behave explicitly.
- Cross-browser refresh must expose the new revision without destroying an unsaved draft. Conflict recovery supports reload or save-as-new.
- Deletion reports references, supports deliberate replacement/removal, and must not silently delete another resource.
- Successful responses identify the saved revision; “saved”, “applied”, “compiled”, and “rendered” are separate outcomes.

**8. Migration and backwards compatibility**

| Existing concept | Target |
| --- | --- |
| `custom_views` table layouts | Page Views with the captured layout plus explicit defaults for previously uncaptured settings |
| `saved_views` selectors/queries | Page Views with query/projection settings and a default presentation |
| `custom_fields` definitions | Custom Fields with explicit object compatibility and versioned typed contracts |
| `react_views` definitions | Object Views; preserve code, origin, author and revision provenance |
| Local field/value/table preferences | Import into scoped user preferences or a user-selected Page View |
| Browser-only layout history | Import recoverable entries with accurate provenance; do not invent missing history |

Preserve IDs through explicit mappings and retain old URLs/tool/CLI names as documented compatibility aliases. Never reinterpret an old ID as another resource type. The existing `datool views` and `list_views` aliases have different semantics; adapters must preserve each until deprecation.

Do not heuristically merge unrelated saved query and layout records because their names match. Migrate each to a complete Page View, retaining origin/type metadata and explicit unset/default settings.

Keep a legacy adapter for existing Object View code expecting `{ trace }`. Newly authored views use explicit object contracts. Migration must not silently reinterpret old dataset output semantics.

Never bulk-import another project's local fields. Import known scoped entries only; unresolved legacy ownership needs a recoverable user-facing import path. Removed historical browser React definitions can only be recovered if source data still exists; do not claim otherwise.

Update application docs, UI labels, CLI help, MCP discovery, WebMCP schemas and the dedicated `vinpac/datool-skills` distribution together. Skills changes belong in that separate repository and must be reported separately from application release state.

**9. Delivery order and completion criteria**

1. Canonical contracts, typed adapters, capability registry and migration fixtures.
2. Database definitions/preferences/history, reference ownership, conflict handling and compatibility adapters.
3. Shared API operations, complete CLI/server MCP discovery, field evaluation and Object View validation/preview.
4. Shared Page View/Custom Field UI integration across all listed table/card surfaces.
5. Object Views across every trace/dataset entry point, including previews of unsaved dataset drafts.
6. WebMCP parity and active-page helpers, plus docs and dedicated skill updates.
7. Cross-surface, migration, isolation and visual verification; separate local tests, published CLI, server deployment and live proof.

Acceptance matrix:

| Scenario | Required evidence |
| --- | --- |
| Cross-interface lifecycle | Create in one interface, read/edit in the other three, reopen from another browser |
| Complete Page View round-trip | Filters/search/sort/date semantics/columns/formats/density/layout/panels/default Object Views survive save and reopen |
| Custom Fields everywhere | Same supported object produces the same typed value in every table/card and headless evaluation |
| Query correctness | Supported Custom Field filters/sorts operate before pagination; unsupported operations return explicit errors |
| Ownership | Applying or restoring a Page View never overwrites a Custom Field/Object View definition |
| Conflicts/history | Stale writes reject; drafts survive; restoring preserves prior revisions and dependency semantics |
| Project/user isolation | Switching projects/users cannot reuse another scope's cache, pending response, preferences or imported local definitions |
| Object correctness | Trace output, dataset expected output, observed output and source evidence remain distinct |
| Preview reliability | Syntax, type/compatibility, runtime, missing/truncated data and timeout failures are distinguishable; headless render claims are verified |
| Lifecycle failures | Deleted dependencies, unavailable storage/network and partial saves leave recoverable state |
| Legacy compatibility | Old IDs, links, commands, saved queries, layouts and `{ trace }` renderers retain documented behavior |
| UI states | Desktop and narrow mobile; loading, empty, error, focus, overflow, keyboard interaction and draft recovery |
| Completeness | Every registered product table/record entry point passes capability checks; no eval-only hardcoded list |

The delivery ledger distinguishes implemented behavior from the remaining full-coverage requirements.
