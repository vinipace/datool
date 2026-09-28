# @datool/cli

Connect local handlers, investigate traces, manage datasets/scorers and run evaluation workflows. Requires Node 22.18+. The install command uses the published documentation baseline; source-only changes described below require the corresponding release and server.

```sh
npm install --save-dev @datool/cli@0.4.0
export DATOOL_BASE_URL=http://127.0.0.1:3000
export DATOOL_PROJECT_ID=your-project-id
export DATOOL_API_KEY=your-organization-key
bunx datool connect
```

`--datool <url>` and `--project <id>` override the environment. `DATOOL_URL` is also supported. The API key needs the corresponding resource permissions. Local app registration needs `apps:write`; resource imports currently need both `datasets:write` and `scorers:write`.

## Configuration and login

The CLI finds the nearest parent containing `package.json` or `.git` (otherwise the working directory). It loads `.env`, then `.env.local`, from that project root, including when invoked from a subdirectory. Existing shell variables win, even when empty. CLI flags win over environment values; a saved OAuth login supplies a host and project only when none are configured. In a monorepo, the nearest package is the project root.

Use `--env-file <path>` to replace the automatic files; paths are relative to the working directory. Repeat the option to load multiple files in order. Use `--no-env` or `DATOOL_NO_ENV=1` to disable file loading. Explicit files and opt-out cannot be combined. File syntax uses Node's dotenv parser, without variable expansion. Keep credential files out of version control.

`npx datool` and `bunx datool` execute the Node shebang. To invoke the JavaScript binary with Bun directly, disable Bun's own preload: `bun --no-env-file node_modules/@datool/cli/dist/datool.js doctor`. Datool rejects direct Bun execution without this runtime flag because preloaded variables cannot be distinguished from shell exports; `--no-env` controls Datool's loader after that.

For interactive use:

```sh
npx datool auth login --datool https://your-datool-host
npx datool doctor
npx datool traces list --limit 1
npx datool auth logout
```

Login opens the browser for organization/project selection and scope consent, then uses a loopback callback and S256 PKCE. `--no-browser` prints the authorization URL to open on the same computer. Tokens are stored in the OS credential store (macOS Keychain, Windows Credential Manager, or a Linux Secret Service); there is no plaintext fallback. Linux needs a running, unlocked Secret Service. Non-secret active-login metadata lives in `~/.config/datool/profile.json`; `DATOOL_CONFIG_DIR` overrides that directory. Refresh tokens rotate automatically. One active login is saved; run login again to change the host or project. Logout removes the local credential and requests server revocation; outstanding access tokens can remain valid until their short expiry.

For agents and CI, `DATOOL_API_KEY` takes precedence over OAuth. Supply an organization key and explicit project. OAuth tokens are bound to their selected host/project and cannot be redirected using CLI flags.

`datool doctor --json` reports CLI/server compatibility, host/project, configuration sources, authentication, and a minimal trace read. It exits 1 if any check fails and never prints credentials or trace contents. A valid key missing `traces:read` produces a specific HTTP 403 permission error, distinct from HTTP 401 for invalid credentials. `doctor` and CLI OAuth require server CLI protocol 1; an older server is reported as incompatible.

```ts
// handler.ts
export default async function (input: { text: string }) {
  return { text: input.text.toUpperCase() }
}
```

Local handlers receive jobs through authenticated outbound polling. Hosted Datool and a CLI on your laptop can communicate without an inbound port or tunnel. Keep the process alive; use `--watch` to reload source changes, or reconnect manually with the default `--no-watch` behavior. Node executes erasable TypeScript; `.tsx`, compiler path aliases and syntax requiring transformation need a separately compiled JavaScript handler.

For a persistent playground catalog, create `datool.config.ts`. It exports a manifest of the workflows and agents this process can handle:

```ts
// datool.config.ts
import { defineApps } from '@datool/cli'
export default defineApps({ apps: [{
  id: 'echo', name: 'Echo', type: 'workflow',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object' },
  handler: (input: { text: string }) => input,
}] })
```

```sh
bunx datool connect
```

Every connect validates and syncs the manifest, then starts an outbound bridge for its handlers. CLI 0.3.0 requires a server with migration `0023_app_connections.sql`. With no path, the CLI finds `datool.config.ts` at the same project root used for `.env` files, including from subdirectories. Pass a path to use another manifest. Reconnect after changing definitions or code; unchanged definitions keep their revision and existing results. Omitted handlers are not deleted. `datool apps sync <config.ts>` remains available as an optional registration-only command.

Use `type: 'workflow'` (the default) for a function receiving the input object, or `type: 'agent'` for a function receiving the messages array. Agent input schemas describe an object containing `messages`. Existing `mode: 'input'` and `mode: 'agent'` configurations continue to work; conflicting `type` and `mode` are rejected. A direct handler file or HTTP URL can still be passed to `connect` for a single-app connection.

Resource imports remain separate:

```sh
npx datool datasets push dataset.json --dry-run
npx datool datasets push dataset.json
npx datool datasets pull dataset-key --out dataset.json
npx datool scorers push scorer.json
```

Use `@datool/sdk` to instrument handlers. Config entries can set `internalTracing: true` and `flushTelemetry: () => processor.forceFlush()`. A bridge confirms complete telemetry only after this hook succeeds. API keys authenticate requests; correlation IDs do not authenticate callers.

## Agent workflows

Version 0.2.0 includes trace/session investigation, scorer tests and immutable versions, asynchronous evaluations, CI gates, dataset snapshots, dashboard previews and bounded NDJSON exports. These commands require a server with migration `0006_agent_foundations.sql`.

```sh
datool agent tools
datool agent tools start_eval_run
datool traces list --filter 'status = "errored"' --limit 25
datool scorers versions scorer-id
datool scorers libraries
datool scorers use-library --input '{"evaluator":"ExactMatch"}'
datool datasets snapshot dataset-id --label release-42
datool evals run --input @evaluation.json --wait
datool evals get run-id --limit 50
datool evals target run-id --target-id target-row-id
datool evals gate run-id --min-score 0.8 --min-pass-rate 1
datool traces export --out traces.ndjson --max-rows 10000
```

Every MCP operation also supports `datool agent call <operation> --input <json|@file|->`. `agent tools` returns the current input schemas and required scopes. Evaluation starts need a stable `requestKey`; reusing it with identical inputs retrieves the original run. Gate failure exits 2; wait timeout exits 3. Exports emit continuation metadata on stderr and preserve existing files unless `--replace` is set.

Eval reads, comparisons, waits and exports omit full trace spans by default. Use `evals target` with a returned row ID to inspect that case's frozen evidence and scorer spans. `--include-evidence` on get, compare or export opts into embedding full evidence. Always follow `nextCursor` or `nextOffset`: pages can shrink automatically to stay within 8 MiB. These defaults require the updated server; older CLI versions can use `datool agent call get_eval_target --input '{"id":"run-id","targetId":"target-row-id"}'`.

See the repository's `docs/agent-foundations.md` for complete examples, bounds and execution semantics. Install agent workflow skills from [datool-skills](https://github.com/vinpac/datool-skills).

## License

Copyright 2026 Vinicius Pacheco. Licensed under the [Apache License 2.0](./LICENSE).

## Registered HTTP apps

`datool connect https://example.com/call` registers an HTTP app that stays available after the command exits. It uses the Datool request envelope. Optional `DATOOL_APP_TOKEN` becomes its encrypted Bearer header. For full configuration, use `datool apps register --input @app.json` with an `app` containing the app definition and `connection: { type: "webhook", url, method: "POST", body: "input" }`. HTTP settings support POST/PUT/PATCH, raw input or envelope, optional headers and 1–60 second timeouts. Omitted headers preserve credentials on edit; `{}` clears them. Supply `expectedRevision` for edits.

`datool apps list` and `get <id>` expose schemas and availability without credential values. `datool apps run <id> --input @run.json` accepts `{ "input": {...}, "requestKey": "stable-key", "scorerIds": [] }` and returns a saved experiment. Required permissions are apps:read, apps:write, evals:read, evals:write and scorers:read. Omit scorerIds to use app defaults.

Local bridge calls have a 60-second deadline and 768 KiB input/output limits, with up to 16 active handlers. Lost network responses retry the same claim/result, not the handler. A process exit does not automatically dispatch unfinished work to a new worker. Inspect its recorded run before requesting another invocation. Shared bridge storage does not add durable evaluation batch scheduling.

## AI-labelled reviews

Review aliases require an updated CLI and server with migration `0029_review_provenance.sql`. Older CLI versions can use `agent call` with the deployed operation schema.

```sh
datool agent tools record_review
datool reviews list
datool reviews get <session-id-or-number>
datool reviews item <session-id> --item-id <item-id>
datool reviews record <session-id> --item-id <item-id> --input @finding.json
datool reviews export <session-id> --out review.ndjson
```

A notes-only `finding.json` uses the item's current revision:

```json
{
  "expectedRevision": 0,
  "notes": "The extracted brand is absent from the captured evidence.",
  "agent": { "name": "Codex", "model": "actual-model-name" }
}
```

Use `reviews create --input @session.json` with `name`, `traceIds` and optional `collectionId` for a separate test session. Inspect criteria through `human-scores list|get` or `agent tools`. Add `scores: [{humanScoreId, humanScoreRevision, value, comment}]` using the returned definitions. Providing scores replaces the complete set; omit it for notes-only updates that preserve scores and completion. Annotations are also supported; inspect `record_review` for their immutable evidence-reference schema. On revision conflict, reread and reconcile before retrying.

Organization API keys need `reviews:write` to submit, `reviews:read` to read, and `traces:read` to inspect evidence/create sessions. API-key and OAuth submissions are always **AI-labelled**; identity is server-derived. Optional agent/model metadata does not change attribution. Readback and NDJSON exports include provenance, `humanVerified` and `completionKind`; sessions distinguish `humanReviewedCount`, `aiReviewedCount` and `aiLabelledCount`. AI ratings never become dataset ground truth automatically.

### Local code watching

Use `datool connect --watch` for a project manifest, or
`datool connect ./handler.ts --watch` for a single handler. Watching is opt-in;
`--no-watch` keeps one-time loading. Source/config changes in the project (including
imports) debounce for 250 ms, then load in a fresh process and resync schemas.
A one-second snapshot catches missed filesystem events on Node and Bun.
Invalid imports/manifests keep the previous listener. Active calls, telemetry
flushes and acknowledged result delivery finish before replacement; uncertain
exchanges are retried without replaying handlers. Queued calls and arrivals
during a drain stay in the same relay mailbox with their original deadlines.
The replacement rotates its session token; stale workers cannot disconnect it.
Schema/definition changes explicitly fail incompatible queued calls before
execution. Ctrl+C drains active work and closes the mailbox. A listener
failure after accepting calls stops the watcher; inspect saved calls before
reconnecting.

Watched extensions: ts/tsx/mts/cts/js/jsx/mjs/cjs/json/yaml/yml. Installed packages,
Git, build/cache/coverage outputs, `.datool`, `tmp`, `temp`, `artifacts`,
`test-results`, and `playwright-report` are excluded. Imports outside the
current/target project roots, environment changes and non-source assets require
reconnecting. HTTP URL registration cannot use `--watch`. Keep code fixed and
watching off for final reproducible experiments.

CLI 0.4.1+ requires bridge protocol 2 for all local connections and the server's
`session-v1` reload support for `--watch`. Deploy the updated server first.
`--no-watch` works with protocol 2 servers that do not advertise `session-v1`.

### Connected evaluation overrides

`datool evals run --input @run.json` accepts `inputOverrides` for connected dataset
runs. It shallow-merges over each object case input: override keys win, objects
and arrays replace whole values, and null is literal. For example,
`"inputOverrides":{"model":"provider/model","promptSlug":"extract","promptVersion":2}`.
Every effective input is validated against the app schema. Original cases,
expected outputs and metadata stay unchanged; only the effective input is sent
to the app. The run freezes inputs and stores `metadata.inputOverrides`.
Overrides participate in `requestKey` identity and cannot accompany re-scoring
(`sourceRunId`), trace scoring or single app calls. Re-scoring preserves the
original frozen evidence. Inspect `datool agent tools start_eval_run` to confirm
server support; the CLI build alone does not establish hosted deployment.

Connected runs accept native `promptOverrides` alongside generic `inputOverrides`. `datool evals run --input @run.json --wait` and MCP `start_eval_run` share the contract. Prompt defaults and explicit versions are frozen for the whole run; applications only call `datool.prompts.get(slug)`. See [managed prompt experiments](https://github.com/vinpac/datool/blob/main/docs/managed-prompts.md#connected-dataset-prompt-overrides).

### MDX reports

Author a small two-file bundle: `report.mdx` contains only the Markdown/component body, while the adjacent `report.data.json` contains `name`, `description`, `sources`, and `bindings`. Keeping narrative/layout separate from query and evidence configuration makes the report easier for agents to revise and review. The CLI loads the adjacent data file automatically; use `--data-file` when it has another name.

```sh
datool reports guide
datool reports components
datool reports recipe
datool reports template evaluation-comparison
datool reports validate --file report.mdx
datool reports create --file report.mdx --creation-key <uuid>
datool reports get 12
datool reports resolve 12
datool reports update 12 --revision 1 --file report.mdx
datool reports update 12 --revision 2 --file report.mdx --refresh
datool reports publish 12 --revision 3
datool reports share 12 --revision 4 --enabled
```

The template returns `document`; the component catalog provides prop schemas and supported Tailwind classes. `validate` returns diagnostics and exits 1 when invalid. Queries use named semantic sources. Components and inline values reference those sources and evidence bindings. Arbitrary JavaScript is not supported. For a non-adjacent data file, pass `--data-file report.data.json` to `validate`, `create`, or `update`.

Creation saves a private draft and captures complete results in one consistent snapshot. Preserve the exact file and UUID for idempotent creation retries. Saving prose/layout preserves evidence; changed queries require explicit `--refresh`. Updates require the current revision. Publish locks the reviewed evidence; public sharing is separate. Use `reports clone 12 --creation-key <uuid>` for a new editable copy of a published report.

Legacy one-file reports with YAML frontmatter remain accepted when no sibling `report.data.json` exists. JSON inputs remain available through `--input`: create accepts `{creationKey,name,description,mdx,sources,bindings}`; update accepts `{number,revision,document,refresh?}`. Discovery needs dashboards:read; validation/reads also need metrics:read; mutations need dashboards:write and metrics:read. Check `datool agent tools create_report` for the deployed contract. Building this CLI does not publish an npm release or deploy the server.
