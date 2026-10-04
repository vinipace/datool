# Custom Page Views

Page Views support table/card layouts, React components, and MDX documents.
Custom content uses `settings.renderer.kind = "react" | "mdx"`.
See [React and MDX Page Views](./react-page-views.md) for the editor, component contract,
and opening traces with a selected Object View. Canonical shared definitions use
`/api/page-views`; `/api/custom-views` remains a compatibility endpoint.

The **Page View** menu captures filters, column order, visibility, widths,
table/card mode, custom field references, and resource-specific settings.
Definitions are shared within a project and scoped to their collection resource.
Selecting a view applies its settings; selecting the default restores that
page's baseline.

Edits remain a browser draft until **Save** is clicked. **Duplicate view** creates
a shared definition from the current settings. The selected view ID is carried
in the `pageView` URL parameter, so the same link can open it in another browser.
**Reset** reloads the saved revision and clears that view's local draft.

Page definitions live in `custom_views` in PostgreSQL. Selector-based data queries
remain distinct from page presentation, though canonical Page Views may retain
a migrated query definition.

## Version history

Each successful update increments a database revision using an atomic
compare-and-swap. Stale saves and deletes return HTTP 409. Reload the saved view,
or duplicate the draft to retain it separately.

Canonical history operations read immutable server revisions. Drafts and the
selected page view stay local to the browser; clearing browser storage removes
those local drafts, but does not remove shared definitions or server history.

Restoring an old snapshot creates a new revision and pins its referenced fields
and Object Views. It never decrements the revision or rewrites prior entries.
Snapshots contain settings and React/MDX source, not collection row payloads.

## API and extension points

- `GET /api/page-views?resource=traces`: list definitions with cursor pagination.
- `POST /api/page-views`: create `{ resource, name, settings }`.
- `GET /api/page-views/:id`: read the current revision.
- `PATCH /api/page-views/:id`: replace name/settings with `{ resource, name, settings, expectedRevision }`.
- `DELETE /api/page-views/:id?expectedRevision=N`: delete the current revision.

Routes use the existing local mutation/origin protection. Settings are validated at the service boundary and formulas remain data on the server; evaluation still happens in the existing bounded browser worker.

`resource` scopes a view to its surface; `settings.schemaVersion` versions its
contract independently of the saved revision. The supported resources live in
`src/lib/tracer/view-resources.ts`. Schema version 1 accepts table presentation
or an optional React `renderer`. Field definitions remain shared resources;
saving a Page View does not edit those definitions.

## Validation

`tests/custom-views.test.ts` and `tests/view-library.test.ts` cover persistence,
revision conflicts, history, dependencies and validation. Draft/cache tests
cover browser state. `tests/custom-view-table.test.tsx` protects existing table
presentation. `scripts/test-react-views-e2e.ts` also runs the real React Page
View editor, sharing, trace navigation, error recovery and responsive proof.
