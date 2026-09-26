# Project React views

The **Views** tab on a trace or dataset row opens one project-wide library. Views live in PostgreSQL (`react_views`), accessible to project members across browsers and devices. Local storage holds only the selected view ID, scoped to the project. Browser-local view definitions are retired without migration.

A view contains a name, description, React code, data mode, nullable data requirements, author, creation/update timestamps and revision. Creation can reference a trace or a saved dataset row. The server validates that source belongs to the project and captures its name, operation, agent/workflow/version and dataset or trace IDs. These snapshots survive source deletion and never restrict reuse. An unsaved new dataset row has no persisted source reference.

Choose **Create new view** to name and edit a view, **Preview** in the overflow menu to render the current draft, and **Save** to share it. The header uses the shared title input with Cancel and Save; descriptions remain optional API metadata without an input in the UI. Edits update the shared definition. **Save as new view** in the overflow menu creates an independent copy with the current record as its origin. Concurrent edits/deletes use `expectedRevision`; a stale request returns 409 and leaves the editor draft available for copying. Refresh reloads the project library. Deletion requires confirmation in the UI and affects the project.

## Compatibility

Requirements for unloaded child details rank as unknown until those details are available. Each requirement has a JSON Pointer `path` (for example `/output/answer`), `type`, `required`, and `nonEmpty`. Supported types are any, string, number, boolean, object, array and null. Escape a literal slash as `~1` and tilde as `~0`; dots in attribute keys need no escaping. Optional fields may be absent, but must match their declared type when present. Nonempty requirements reject empty strings/arrays and null. Array indices can be expressed as `/spans/0/name`.

- `requirements: null`: unknown; requirements have not been reviewed.
- `requirements: []`: explicitly reviewed, no specific field requirements.
- A populated array checks only the listed paths against the actual preview payload.

The picker sorts requirements met, unknown, then requirements missing. Matching operation or agent/workflow breaks ties, followed by stable name/ID ordering. The picker shows names only, with a search icon and alignment to the title trigger. Every view remains selectable. Compatibility and origin metadata are available through the API; they are not displayed above the preview. Requirements matching does not guarantee correct rendering; preview success applies only to that record and code revision.

New views created in the UI start with unknown requirements; copies preserve an existing contract when their code is unchanged. The UI provides no controls to set requirements. API and WebMCP callers can supply an explicit reviewed contract. The suggestion endpoint parses direct `trace` field accesses and uses example values for suggested types without executing code. Suggestions are incomplete for aliases, dynamic paths and conditional reads; callers must review them before saving. Editing code or data mode in the UI clears any previous contract; renaming preserves it.

Dataset previews use the current form input as `trace.input`, expected output as `trace.output`, and metadata as `trace.attributes`, with empty spans/scores. Compatibility uses that same payload, including valid unsaved edits. Invalid form values must be corrected first. Original trace context is metadata, not a substitute for expected output.

## Rendering and APIs

Code exports a default React component taking `ViewProps { trace }`. Imports from `react`, `@datool/ui` and `@datool/charts` are supported; [runtime details](./react-trace-views.md) describe worker compilation, caching, Tailwind and data modes. Rendering stays inside the existing `allow-scripts` iframe sandbox, with network access blocked by CSP. Syntax errors, render errors and unhandled async errors appear in the preview. Successful rendering adds no status label. Selecting another view recovers the preview.

All endpoints require the project header/query scope and existing authentication. Reads use `views:read`; writes and suggestions use `views:write`. Capturing origin context additionally requires read access to that source type. Author identity comes from the authenticated request.

- `GET /api/react-views?cursor=…&limit=50`: paginated metadata, maximum 100 per page; code is excluded.
- `GET /api/react-views/:id`: complete saved definition.
- `POST /api/react-views`: `{ name, description, code, dataMode, requirements, source }`, where source is null or `{ kind: "trace" | "dataset-item", id }`.
- `PATCH /api/react-views/:id`: `{ name, description, code, dataMode, requirements, expectedRevision }`; origin and author remain immutable.
- `DELETE /api/react-views/:id?expectedRevision=N`.
- `POST /api/react-views/suggest`: `{ code, sample }`; returns unaccepted suggestions and limitations.

The in-browser WebMCP list/get/create/update/select/delete trace-view tools use the same project APIs. Updating code without supplying reviewed requirements resets compatibility to unknown. Saved table layouts (`custom_views`) remain a separate feature.

## Verification

`DATOOL_TEST_DATABASE_URL` must identify a disposable loopback PostgreSQL database distinct from `DATABASE_URL`. Run `bun test tests/react-views.test.ts` for compatibility, provenance, persistence, isolation and conflicts. Run `bun run test:react-views:e2e` for the real authenticated browser/API/database flow, with separate owner and teammate browser contexts, trace/dataset reuse, compatibility ordering, conflict recovery, mobile preview, server restart and deletion. Evidence is written to ignored `artifacts/react-views-e2e/`; the test schema is removed afterward.
