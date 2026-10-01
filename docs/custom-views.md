# Custom eval-run views

Use **Save as view** on an eval run to capture computed column definitions, column order, visibility, widths, table/card mode, and the Details panel setting. The picker lists views shared by every eval run connected to this database. Selecting a view replaces these settings; row selection and the comparison run are not part of a view.

Edits remain a draft until **Save changes** is clicked. The selected view ID is carried in the `view` URL parameter, so reopening that URL loads the latest database revision. Formula and order changes through the existing WebMCP tools update the same draft and enable Save changes. Unsaved computed columns and order retain the existing per-run browser storage behavior.

The current view lives in `custom_views` in PostgreSQL. This is separate from the older `/api/views` selector/projection feature. The initial migration `migrations/0001_initial.sql` creates this table alongside the other application tables.

## Version history

Each successful update increments a database revision using an atomic compare-and-swap. Stale saves and deletes return HTTP 409; the UI offers reloading the current view, while Save as view can preserve a conflicting draft separately.

The latest 50 saved revisions observed in a browser are stored under `datool:custom-view-history:<viewId>`. Before overwriting a database revision, the browser must preserve that revision locally. If that fails, updating is stopped with an actionable error. Other browsers can use the latest database view, but have their own local history. Clearing browser storage removes that browser's rollback history.

**View history → Restore** writes an old snapshot as a new revision and applies it to the table. It never decrements the revision or rewrites a previous history entry. Local versions include names and complete settings; they do not contain eval row payloads.

## API and extension points

- `GET /api/custom-views?resource=eval-runs`: list layouts.
- `POST /api/custom-views`: create `{ resource, name, settings }`.
- `GET /api/custom-views/:id`: read the current revision.
- `PATCH /api/custom-views/:id`: replace name/settings with `{ resource, name, settings, expectedRevision }`.
- `DELETE /api/custom-views/:id?expectedRevision=N`: delete the current revision.

Routes use the existing local mutation/origin protection. Settings are validated at the service boundary and formulas remain data on the server; evaluation still happens in the existing bounded browser worker.

`resource` scopes a view to its surface; `settings.schemaVersion` versions its settings contract independently of the saved revision. Currently only `eval-runs` with schema version 1 is accepted. To add traces or sessions, add a resource-specific settings schema and adapter, then expose the picker on that page. Don't apply eval-only formulas or fields to another resource implicitly. The `CollectionTable` accepts controlled presentation settings while retaining its existing uncontrolled behavior elsewhere.

## Validation

`tests/custom-views.test.ts` covers persistence across database connections, concurrent writes, revision conflicts, restore/delete, validation, bounded local history, and dirty detection. `tests/custom-view-table.test.tsx` verifies controlled display settings while retaining fixed table actions. Existing computed-column/WebMCP and table-card regressions also run.
