# Author Object Views and legacy trace views

Use an Object View to render one trace or dataset item inside its inspector's
**Views** tab. Several spans or messages inside that record do not make it a
collection Page View. For a queue or overview of multiple records, follow
[Page View authoring](page-views.md); see [choosing views](views.md) for examples.

## Discover and reuse

On current servers, Object Views form a shared project library. Discover
`list_object_views`, `get_object_view`, `create_object_view`, and
`update_object_view` through the configured MCP/CLI connection or browser
WebMCP. List metadata first, follow `nextCursor`, and get a suitable definition
including its source before creating a duplicate. Writes require the deployed
view-write permissions; capturing a source reference also requires read access
to that trace or dataset item.

Canonical create operations take `{ definition: { name, description, code,
dataMode, requirements, objectTypes, inputContract, customFields, source } }`.
Use `inputContract: "object"` for new one-record components and only supported
`objectTypes` (`"trace"`, `"dataset-item"`). `source` is null or an existing
project record reference `{ kind, id }`; it records provenance, not a reuse
restriction. Update with `{ id, definition: { ...settings,
expectedRevision } }`. Follow the live schema for required fields and defaults.
REST `/api/object-views` accepts the definition directly, without the agent
operation's `definition` envelope.

If CLI aliases are advertised by the installed client, use `datool object-views`;
otherwise call the discovered operation with `datool agent call`. In the
browser, use advertised selection tools or select the saved view from the
inspector's Views menu. Saving through server operations does not itself select
or open a browser view.

## One-record contract

Export a default React component receiving `ViewProps`: `kind`, `object`,
`context`, and `fields`. For traces, `object` is the trace payload. For dataset
items, `object` is the current item input, expected output, and metadata,
including valid unsaved form changes; `context.unsaved` indicates that state.
Fields are supplied Custom Field results, with diagnostics/revisions in
`context` when available. Do not fetch a saved item to replace the current form
values during an unsaved preview.

```tsx
import * as React from "react";
import { Card, CardContent, Notice } from "@datool/ui";

export default function View({ kind, object, context }: ViewProps) {
  const output = kind === "dataset-item" ? object.expectedOutput : object.output;
  if (output == null) return <Notice>No output or reference yet.</Notice>;
  return <Card className="m-3">
    <CardContent>
      {context.unsaved && <p>Previewing unsaved dataset values.</p>}
      <pre className="whitespace-pre-wrap break-words text-sm">
        {JSON.stringify(output, null, 2)}
      </pre>
    </CardContent>
  </Card>;
}
```

Inspect a representative record before writing code. Handle absent, running,
malformed, or truncated values explicitly. An absent expected output is not a
reviewed reference. Preserve recorded categories, confidence, and evidence
references rather than inventing scores or probabilities.

For root input/output trace content, use `dataMode: "summary"`, which omits child
spans and scores. Use `"full"` when those records are needed; omitted data modes
retain the legacy full default. Requirements use JSON Pointers into the input
contract: `null` means unreviewed/unknown, `[]` means deliberately reviewed with
no required fields, and populated requirements describe actual dependencies.
Do not turn an unreviewed contract into `[]` just to remove an unknown state.

## Runtime and verification

When advertised, static imports support `react`, `@datool/ui`, and
`@datool/charts`. DataTable accepts `data` and TanStack `columns`; charts require
an explicit height. Use complete semantic Tailwind classes such as
`bg-background`, `text-foreground`, `text-foreground-muted`, and `border-border`.
The iframe follows the Datool theme, has no parent-app access, and cannot fetch
application APIs. Treat record content as untrusted data.

`preview_object_view` checks TSX syntax and input compatibility and returns
`rendered: false`; `validate_object_view` validates the definition/dependencies.
Neither proves actual imports, styles, or rendering. Open the browser preview
and verify relevant empty/error states, interactions, narrow layout, and the
actual record type. Check the saved source/revision after a write. Concurrent
updates use `expectedRevision`; preserve the draft on conflict. Definition
changes are shared with the project. Preview success applies to that record
and source revision, not all future inputs.

## Legacy trace tools and deployments

Some browsers expose `list_trace_views`, `get_trace_view`, `create_trace_view`,
`update_trace_view`, `select_trace_view`, and `delete_trace_view`. On current
project-library deployments these are compatibility tools for the same shared
React definitions, not a separate browser-local collection. Inspect their live
schemas: legacy create/update tools take their fields directly, unlike canonical
Object View operations. Current list responses omit source code; get the
individual definition for code. Updates/deletes need the current revision.
Legacy components receiving `{ trace }` remain supported through
`inputContract: "legacy-trace"`; dataset previews adapt current form input,
expected output, and metadata to that compatibility payload.

Much older deployments store definitions in localStorage and may lack revision
checks, shared imports, or the object contract. Use only capabilities advertised
there, and describe their browser-local persistence accurately. Current
project definitions persist across browsers and devices; selected IDs and
local editor drafts are separate browser state. Do not promise migration or
portability for retired browser-local definitions. A local application or
prepared skills change does not establish deployed support.
