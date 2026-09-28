# Managed prompts

Published SDK 0.2.0 supports this API. Confirm the installed `@datool/sdk` exposes `createDatool().prompts` and the live
`start_eval_run` schema advertises `promptOverrides`. Connected runs also need a
CLI bridge or HTTP adapter that forwards prompt scopes. Repository versions
alone do not establish package publication or server deployment. Manage drafts
and publish versions in the Prompts UI; management operations are not in the
shared agent catalog.

## Fetch and render

```ts
import { createDatool } from "@datool/sdk"

const datool = createDatool() // DATOOL_BASE_URL, DATOOL_PROJECT_ID, DATOOL_API_KEY
const prompt = await datool.prompts.get("support-reply")
const messages = prompt.render({ text: "Example input" })
```

Standalone fetching requires `prompts:read` and no `connect` process. It reads
the latest published version; `{ version: 2 }` pins a publication. Unpublished
slugs return 404. Rendering takes string values, treats dotted names as literal
keys, reports missing variables, and neither recursively substitutes nor
HTML-escapes values. The application resolves `prompt.model` into its model
provider, maps `prompt.settings` to generation options, and owns output schemas.

## Invocation scopes

`connect` installs a fresh scope per call. For an HTTP app, import
`withDatoolRequest` from `@datool/sdk/context` and wrap the authenticated handler:
`withDatoolRequest(request, async () => { /* SDK calls */ })`. Datool headers
carry correlation and prompt scope; they do not authenticate the webhook.

For a standalone experiment, use
`datool.prompts.withScope({ "support-reply": { version: 2 } }, async () => { /* calls */ })`.
Inside a scope, `override(slug, { version, model })` replaces that client's
selection and `reset(slug)` removes it. Both throw outside a scope. Overrides
affect subsequent fetches, never returned values or in-flight reads. Nested
scopes copy parent selections; success and failure restore the parent. Await
work inside the scope, and give concurrent branches separate scopes when they
mutate different selections.

## Connected dataset experiments

Use top-level `promptOverrides`, keyed by observed published slugs, with optional
`version` and `model`. Adapt [the run starter](../../datool-evaluations/assets/prompt-overrides-run.json)
with observed app, dataset and scorer IDs and a stable requestKey. These controls
use `mode: "connected"`, `datasetId` and the chosen snapshot's `datasetVersionId` for a fresh frozen selection. Omitting datasetVersionId deliberately selects the live dataset. Servers advertising `parentRunId` can instead inherit a prior connected run's frozen cases; do not combine that parent with a new target selection. Keep prompt controls out of dataset inputs and do not combine them with trace scoring, a single app input or `sourceRunId`.

The SDK credential needs `prompts:read`, `evals:read` and `traces:write` and must
match the connected project/server. Before invocation, Datool freezes all
published defaults, including lazy lookups. Inspect `metadata.promptConfig` for
that baseline and `Prompt: <slug>` spans for actual ID/version/model. Scoped
version overrides take precedence over explicit `get` versions, then the frozen
default. Scoped model overrides take precedence over run model overrides, then
the published model. Reset restores the frozen baseline. Unknown slugs, replaced
identities and versions published after the snapshot fail. Provenance writes
are awaited; their failure fails the lookup.

Changed overrides require a new requestKey. Re-scoring copies frozen evidence
and configuration without app calls or prompt reads and accepts no overrides.
For prompt experiments, follow the [evaluation improvement loop](../../datool-evaluations/SKILL.md#disciplined-improvement-loop) to hold cases and unrelated versions constant. The limit is 100 requested overrides and
a snapshot of at most 10,000 published prompts/512 KiB.

## Cache behavior

The SDK cache is private to each client: latest reads default to 30 seconds;
pinned versions persist until LRU eviction (256 entries by default). Use
`promptCache: { latestTtlMs: 0 }` to disable latest reuse. Server Redis caching
has a separate hard 60-second lifetime with mutation invalidation; missed
invalidation can therefore yield up to 90 seconds of staleness with defaults.
Run manifests bypass these latest caches. Failed requests are not cached.
Deletion or credential revocation does not remove definitions already cached
in an application; a new client drops that cache.
