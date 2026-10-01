# Dataset item editor

The dataset detail route uses the shared CollectionTable, CollectionFilterBar and workspace inspector dock. Selecting a row opens its input, expected output and metadata editors. With no row selected, the dock shows the dataset description, metadata and evaluation runs. Narrow screens use a dialog with keyboard focus containment.

`components/tracer/datasets-page.tsx` owns queries, selection, drafts and optimistic writes. The row table, item inspector, dataset details and schema dialog are adjacent `dataset-*` components. Reusable Monaco, structured-value, schema-preview and section controls live in `components/ui/`. The existing scorer editor delegates to the same Monaco control.

The item inspector has **Form**, **Runs**, and **Views**, using the same tabs as the trace inspector. Form contains the existing editors and row details. Runs uses the same traces table and columns as the Traces page. It pages distinct traces from evaluations of this item through `GET /api/traces?datasetItemId=...`; matching includes live item references and frozen dataset-case IDs, within the selected project. Clicking a row or pressing Enter/Space opens that trace page.

Views reuses the trace inspector's React view library, selection, editor and sandboxed preview. Existing views receive the current form input as `trace.input`, expected output as `trace.output`, and metadata as `trace.attributes`. This preview represents the dataset row, with its own ID and empty spans/scores; it does not fetch the source trace or substitute unreviewed observed output for expected output. Valid unsaved values are previewed; syntax errors and invalid metadata must be corrected in Form. Views are stored in the project database and shared with teammates across browsers. Trace and dataset origins are context only. See [Project React views](./react-views.md) for compatibility requirements and editing.

## Editing

- Add Row opens a row immediately with `{}` for Input, Expected and Metadata. Valid changes autosave after 650 ms of inactivity; the table updates optimistically and rolls back on failure while retaining the draft. Invalid JSON or enforced-schema violations wait for correction. Validation messages appear once beside the affected field.
- Drafts survive row navigation and closing/reopening the inspector during the page session. JSON and YAML preserve the value's types. Text mode edits string values. Pretty and Tree are read-only views.
- Input, Expected and Metadata in the row inspector grow and shrink with their content, including wrapped editor lines.
- The header shows Saved/Saving and the current dataset version. Each row has a serialized save queue: editing during a request preserves the latest draft and schedules the next save using the returned row version. Row navigation flushes pending valid edits. A failed save offers Retry; a stale cross-session edit is rejected instead of overwriting newer content. Metadata must be an object. Source trace IDs retain project-scoped validation.
- Import accepts a JSON array of up to 100 items. The existing bulk operation validates and saves the batch atomically. Export includes selected rows when any are checked, otherwise the loaded rows.
- Item filters are evaluated in SQL before pagination and counts. Supported fields are `id`, `input`, `expectedOutput`, `metadata`, `sourceTraceId`, `createdAt` and `updatedAt`, including nested JSON paths. For example: `metadata.locale = "pt" input.question : "plan"`.

## Custom columns and display

Add Column uses the same shared field picker, Monaco expression/template editor, preview and isolated worker as eval runs. Dataset expressions receive the native item as `row`, including `row.input`, `row.expectedOutput`, `row.metadata` and their nested properties. Autocomplete uses the loaded dataset rows. Computed cells are read-only; they never write dataset items or create dataset versions. Field definitions use the existing shared registry, while the chosen columns persist per dataset and workspace in this browser. Headers support editing/removing the column, resizing, hiding and reordering.

The row inspector shows the same custom fields and their values for the selected row. Add custom field reuses the shared picker to select an existing field or create one, with the selected row as the preview. Adding or removing a field updates both the table and inspector.

Display offers Compact and Tall row heights. Compact keeps one clipped line; Tall wraps complete field values and grows to fit, including custom columns. The virtualizer measures those heights. Row height, column visibility and sizing persist per dataset and workspace in this browser.

Display also sets the Input, Expected and Metadata field views independently: JSON, YAML, Text, Pretty or Tree. These preferences are shared with the row inspector's format selectors and persist in the same table settings. Switching views changes presentation only; it does not autosave, coerce values or create versions. Text is editable for strings and read-only for structured values. Invalid drafts stay visible and editable in their original language until corrected.

## Schemas

Migration `0007_dataset_field_schemas.sql` adds dataset metadata and field schema configuration. Dataset PATCH accepts `metadata` and `fieldSchemas`, keyed by `input`, `expectedOutput` and `metadata`. Each field uses `{ schema: JSONSchemaObject | null, enforced: boolean }`. Supplied field configurations replace those fields; omitted fields remain unchanged. Clear a field with `{ schema: null, enforced: false }`.

Schemas use JSON Schema Draft 7 with standard formats. The dialog offers Monaco editing, inference from the selected/first loaded example and an interactive form preview. Inference is a starting point, not a claim about every item. A schema may be saved as a suggestion, or enforced independently for that field.

Enforcement validates the complete resulting row on create, patch, bulk import and resource sync. Parent dataset locks serialize schema updates with item writes. Enabling enforcement preserves existing rows; subsequent saves must satisfy all enforced schemas. Validation never coerces values or strips properties. Invalid schemas and asynchronous schemas are rejected. Dataset snapshots freeze metadata and schemas alongside item contents.

## Version history

Migration `0008_dataset_versions.sql` adds a change journal with previous/new documents, a monotonically increasing dataset revision and stable version IDs. Database triggers record item create/update/delete and settings changes in the same transaction as the write, including bulk imports and resource sync. Identical content does not create another version. History is project scoped, paginated and accessible through the header's Version button and `GET /api/datasets/:id/versions`. Existing evaluation snapshots remain separate immutable full-dataset artifacts; autosave stores only changed documents. History begins when this migration is applied; the first change also preserves the previous value.

## Verification

`tests/dataset-autosave.test.ts` covers coalescing, in-flight edits, validation, retry and navigation. `tests/dataset-versions.test.ts` covers atomic history, no-op retries, stale concurrent edits, import rollback, deletion, pagination and project isolation. The shared Monaco editor keeps its model during saves; external value changes preserve selection, scroll position and undo history without emitting another edit.

`tests/dataset-schemas.test.ts` covers persistence, all three fields, partial updates, enabling/disabling enforcement, invalid schemas, atomic bulk rollback, resource sync, immutable snapshots, project boundaries, filtered pagination and typed JSON/YAML conversions. Database tests require a disposable local `DATOOL_TEST_DATABASE_URL` and never use the configured application database.

## React views

The dataset row **Views** tab shares the project library with traces. Its preview uses the current form input, expected output and metadata, including valid unsaved edits. See [project React views](./react-views.md).
