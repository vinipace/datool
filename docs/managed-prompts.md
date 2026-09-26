# Managed prompts

Prompts live at `/p/<projectSlug>/prompts`, with `/new` for creation and `/<id>` for editing. The collection uses the same filtering, selection, export and saved table views as Scorers. The split editor reuses the project model selector and Playground chat surface.

Each prompt has an editable draft and immutable published versions. Changes autosave after a short pause without changing the version agents receive. New prompts begin autosaving once they have a name and valid slug. Saves are serialized; typing during a request keeps newer edits and saves them with the returned revision. Failed saves retain local edits and show Retry autosave. Drafts require a name and project-unique slug but may have an unfinished model or message text. **Publish** validates the saved draft and creates the next numbered version; an unchanged published configuration is a no-op. The collection shows Draft, Published, or Unpublished changes, with the current published version. The editor keeps publication state in the version picker and shows save errors only when needed. Publish waits for outstanding draft changes to save before publishing. There is no Save draft button.

Draft saves and publications advance `revision`, the optimistic concurrency token. `publishedVersion` is the latest published version number; `version` identifies a requested published snapshot and is null when reading the working draft. Updates, publication and deletes require `expectedRevision`; stale revisions return 409. Historical versions remain unchanged. The compact version picker in the page header marks only the current published version. Selecting an older version opens a read-only snapshot without changing the draft. Restore to draft copies it into the autosaved draft; Publish then creates a new version. Published slugs stay fixed so draft work cannot break agent lookup URLs.

Mustache mode supports named placeholders such as `{{customer}}` and `{{account.name}}` (the latter is a literal variable name). Values are inserted as plain text without evaluation, recursion or HTML escaping. Sections, helpers, image/file parts and tool/MCP execution are not supported. Plain text mode leaves braces untouched. Preview values and conversations are not stored in the managed prompt.

Agents fetch the latest **published** prompt by slug. An unpublished prompt returns 404:

```sh
curl "$DATOOL_URL/api/prompts/by-slug/support-assistant" \
  -H "Authorization: Bearer $DATOOL_API_KEY" \
  -H "x-project-id: $DATOOL_PROJECT_ID"
```

Use an organization API key with `prompts:read`. The response is `{ data: { id, name, slug, model, messages, template, output, metadata, version, publishedVersion, revision, ... } }`. Append `?version=1` to pin a version. `/api/prompts/<id>?version=1` also reads a pinned published version. Without a version, that management endpoint returns the working draft; do not use it for agent runtime lookups. Agent applications render the named variables and use the returned model configuration in their own runtime. Names and other content can change in drafts; the published slug remains stable.

Published lookups use a shared Redis cache when `REDIS_URL` is configured. Cache hits avoid prompt SQL queries and schema parsing and return the full configuration, including `provider`, `model`, optional `temperature`/`maxTokens`, and `metadata`. Project, lookup kind, slug/ID and requested version isolate entries. Authorization and project access checks still run on every request; HTTP responses remain `Cache-Control: no-store` so browsers and shared proxies cannot bypass them.

Entries have a hard 60-second maximum age. Successful saves, publications and deletes invalidate the project's prompt cache after the database commit, across server processes; a pre-invalidation read cannot repopulate it afterward. Concurrent misses within a server process share one database read. Working drafts, lists, missing prompts and errors are not cached. Redis failures fall back to PostgreSQL without failing reads or committed mutations. If invalidation cannot reach Redis during an outage, a recovered cache can retain the prior response only for its remaining original 60-second lifetime; there is no stale-on-error extension.

Create a draft with `POST /api/prompts`, save draft changes with `PUT /api/prompts/<id>`, publish the saved draft with `POST /api/prompts/<id>/publish` and `{ "expectedRevision": 3 }`, and delete with `DELETE /api/prompts/<id>`. Listing and ID-based management reads include draft state. Writes and `POST /api/prompts/test` require `prompts:write`. All routes use the existing project authorization and mutation-origin checks. Test requests contain `{ config, variables, messages }`; messages are the preview user/assistant history. The project needs a configured Vercel AI Gateway key. Preview sends rendered template messages followed by conversation history to the [Gateway Chat Completions API](https://vercel.com/docs/ai-gateway/openai-compat/rest-api). JSON output requests JSON-object mode and requires model support.

Apply `0022_managed_prompts.sql` and `0023_prompt_publishing.sql` through `bun run db:migrate` before using the feature. The publishing migration retains existing saves as published versions, preserving all previously served prompts; deleting a project or prompt cascades to its versions.

Validation: `tests/prompt-publishing-migration.test.ts` verifies existing version preservation. `tests/prompts.test.ts` exercises rendering, preview request construction, scopes and persistence/concurrency in a disposable PostgreSQL schema. `components/tracer/prompts-page.stories.tsx` covers collection states, draft creation, dirty-state handling, publishing, chat preview, version restoration, save/publish failures and a narrow editor.

`tests/prompt-cache.test.ts` uses real PostgreSQL and Redis to verify zero prompt SQL queries for 100 warm reads, coalesced misses, cross-instance invalidation, pinned versions, expiration and Redis failures. `tests/prompts-integration.test.ts` also checks cached route responses, fresh authorization, API-key revocation and deletion. These run in package CI with disposable PostgreSQL and Redis services.
## Native SDK

The repository example runs directly from a clean checkout with the Datool
environment variables configured:
`bun run examples/managed-prompts.ts brand-extraction '{"text":"Example"}'`.
It imports SDK source; installed applications use `@datool/sdk` below.

```ts
import { createDatool } from "@datool/sdk";
const datool = createDatool(); // DATOOL_BASE_URL, DATOOL_API_KEY, DATOOL_PROJECT_ID
const prompt = await datool.prompts.get("brand-extraction");
const result = await generateText({
  messages: prompt.render(caseVariables),
  model: resolveModel(prompt.model),
  output: extractionSchema,
});
```

`new DatoolClient(options)` exposes the same `prompts` API. Normal fetching needs
no `connect`, template engine or application cache. Provider resolution and the
output schema stay in the application. `get(slug, { version: 2 })` pins a published
version. The returned `RuntimePrompt` has typed text messages, `id`, `slug`,
`version`, `model`, `provider`, `metadata`, and `settings` (`temperature`,
`maxTokens`, `output`). Translate generation settings to your provider's parameter
names, for example `maxOutputTokens: prompt.settings.maxTokens` for AI SDK.
`render(variables)` accepts string values, throws with all missing variable names,
and returns a new message array. Dotted names are literal keys; substituted text
is never interpolated again or HTML-escaped.

```ts
await datool.prompts.withScope({}, async () => {
  datool.prompts.override("brand-extraction", { version: 2, model: "openai/gpt-4.1-mini" });
  const candidate = await datool.prompts.get("brand-extraction");
  datool.prompts.reset("brand-extraction");
});
// Equivalent: withScope({ "brand-extraction": { version: 2 } }, callback)
```

Each client has its own overrides. `override` replaces that slug's override
rather than merging it. It affects subsequent `get` calls; it cannot change
already returned prompts, in-flight lookups, or cached published definitions.
`override` and `reset` throw outside `connect`, `withDatoolRequest`, or
`prompts.withScope`. `get` works normally outside a scope. Nested callback scopes
inherit a copy of the parent's overrides; child reset removes the inherited
entry in that child only. Completion or failure clears the child and restores
the parent. Concurrent branches that need distinct mutations should each enter
`withScope`. `connect` always starts a fresh scope for each call and cleans it
up on success or failure. Await work inside the callback; detached background
work is not part of the invocation.

Caches are private to the client, including its server, project and credentials.
Pinned published definitions remain cached until LRU eviction. Latest-published
lookups refresh after 30 seconds by default (no stale-on-error fallback). Configure
`promptCache: { latestTtlMs: 0, maxEntries: 256 }` to disable latest reuse. TTL
must be 0–300,000 ms; capacity defaults to 256 and supports 1–10,000 entries.
Concurrent identical reads deduplicate, failed requests are never cached, and
each result is copied so caller mutations cannot corrupt cache entries. Revoking
a key or deleting a prompt does not invalidate a definition already cached by a
running process; create a new client to drop its cache immediately.

Published HTTP lookups also use the server's Redis cache, with a hard 60-second
maximum age and invalidation on save, publish and delete. Each HTTP request still
authorizes the key/project; Redis failures fall back to PostgreSQL. During a
missed invalidation, a latest lookup can retain an old response for the remaining
server lifetime plus the configured SDK TTL (at most 90 seconds with defaults).
HTTP responses use `no-store`; the SDK cache is explicit application behavior.
Run manifests bypass both latest caches and read one database snapshot. Pinned
version contents remain immutable regardless of either cache.

## Connected dataset prompt overrides

```json
{
  "mode": "connected",
  "appId": "extract",
  "datasetId": "dataset-id",
  "evaluatorIds": ["scorer-id"],
  "requestKey": "brand-v2-mini",
  "promptOverrides": {
    "brand-extraction": { "version": 2, "model": "openai/gpt-4.1-mini" }
  }
}
```

Use this body with `datool evals run --input @run.json --wait` or MCP
`start_eval_run` (REST `/api/evals` uses the same body without `requestKey`).
The Run dataset dialog offers published prompt, version and model controls.
These settings remain separate from `inputOverrides`, dataset inputs, and
expected answers. Applications continue to call only `datool.prompts.get(slug)`.

Before the first invocation, one database snapshot resolves **every published
prompt in the project**, plus explicit historical overrides. The run stores
`metadata.promptConfig` with IDs, selected versions, publication ceilings,
effective models and requested overrides. Lazy first use therefore reads the
version frozen at run creation, even after another publication. A slug absent
from the snapshot fails; a deleted/recreated identity or a version newer than
the snapshot also fails rather than falling back to latest. A programmatic
version override may select an older immutable version up to that ceiling.
Explicit `get` versions and scoped overrides take precedence over the frozen
default version; scoped model overrides take precedence over the run model.
`reset` restores the frozen run baseline. Actual resolutions are retained in
prompt provenance spans, including programmatic deviations from the baseline.

The catalog snapshot is bounded to 10,000 prompts and 512 KiB and each request to 100 prompt
overrides. Historical definitions are fetched from published runtime endpoints;
deleting a required prompt before its first fetch can fail the run. Publishing
new versions cannot change an existing run. Retries with the same `requestKey`
reuse the same run and frozen configuration; changing requested overrides with
that key is a conflict. Re-scoring copies frozen evidence and configuration,
never invokes the app or fetches prompts, and rejects new prompt overrides.
Case comparisons still pair by dataset case identity.

The bridge transports only the project/run reference. SDK clients authenticate
the frozen-config read independently through `/api/evals/<id>/prompts` and must
match the connected project's ID (and bridge server URL). Clients from another
project fail closed. Standalone fetching requires `prompts:read`; connected
fetching also requires `evals:read` and `traces:write` for automatic provenance.
For HTTP apps wrap the handler in `withDatoolRequest(request, callback)` to
install the invocation and prompt scope from Datool's headers. Protect that
endpoint with your normal webhook authentication.

Each successful connected lookup awaits a direct `Prompt: <slug>` span write
with resolved ID, version and effective model, even without an app telemetry
setup. A provenance write failure fails the lookup. Existing active OpenTelemetry
spans also receive `datool.prompt.resolve` events for standalone instrumented
applications. Prompt variables, API keys and prompt contents are not added to
these records. A plain standalone fetch without an active span creates no trace.
