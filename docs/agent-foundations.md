# MCP, CLI and skill foundations

Datool now exposes **61 shared operations** through MCP and `POST /api/agent/:operation`: 39 read operations and 22 operations requiring write permission. This adds 29 operations to the previous 32. Each transport uses the same validation and execution catalog. The CLI adds workflow commands, bounded NDJSON exports and CI exit codes. The published [`datool` skill](../skills/datool/SKILL.md) explains how to use the five groups together.

## Setup and permissions

These changes require the application migration `0006_agent_foundations.sql` and a CLI built from this checkout. They are not yet an npm release or a production deployment. Apply migrations through the existing deployment process. The migration adds dataset snapshots and evaluation request records; it does not rewrite existing application data.

```sh
export DATOOL_BASE_URL=http://127.0.0.1:3000
export DATOOL_PROJECT_ID=your-project-id
# Set DATOOL_API_KEY through your environment or secret manager.
bun run bin/datool.ts --help
bun run bin/datool.ts agent tools start_eval_run
```

The examples below use the built `datool` executable. For source execution, replace `datool` with `bun run bin/datool.ts`.

MCP now supports `traces:read`, `evals:read` and `evals:write` in addition to its existing scopes. Existing tokens retain their original consent. Renew consent or issue appropriately scoped organization keys to access added operations. HTTP POST does not imply write permission: read operations explicitly require their resource's read scope. Every operation is project-bound.

| Group                                   | Main permissions                                                            |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Trace/session investigation             | `traces:read`                                                               |
| Scorer configuration and versions       | `scorers:read`; changes need `scorers:write`                                |
| Real-trace scorer preview               | `scorers:read`, `scorers:write`, `traces:read`, `datasets:read`             |
| Evaluation reads/compare/gate           | `evals:read`                                                                |
| Evaluation start/re-score/app execution | `evals:write`, `evals:read`, `traces:read`, `datasets:read`, `scorers:read` |
| Dataset snapshots                       | reads need `datasets:read`; creation also needs `datasets:write`            |
| Dataset bulk edits                      | `datasets:write`                                                            |
| Dashboard preview                       | `dashboards:read`, `metrics:read`                                           |
| Saved-view data                         | `views:read`, `traces:read`, `evals:read`                                   |

Execution operations conservatively require all listed scopes even when optional dataset context is omitted. `describe_agent_operations` / `datool agent tools` provides the exact schema and scope list for every operation. The existing resource push endpoint still requires both dataset and scorer write permissions.

## 1. Trace investigation

```sh
datool traces list --filter 'status = "errored"' --limit 25 --include-total
datool traces get trace-id
datool traces spans trace-id --limit 50
datool traces path trace-id --span-id span-id
datool traces scores trace-id
datool sessions list --limit 25
datool sessions get session-id
datool traces list --session-id session-id --cursor cursor-from-previous-page
```

Full trace evidence is capped at 8 MiB; spans and scores can be paged separately. Trace, session and evaluation filters use the existing typed filter language. Dataset listing uses a text search over name and description. Child item/span pages do not accept an ignored filter.

## 2. Scorer development

```sh
datool scorers get scorer-id
datool scorers versions scorer-id
datool scorers version scorer-id --version-id immutable-version-id
datool scorers test --input @test-scorer.json
datool scorers update scorer-id --expected-revision 2 --input @updated-scorer.json
```

`test-scorer.json`:

```json
{
  "scorerId": "scorer-id",
  "versionId": "immutable-version-id",
  "traceId": "trace-id",
  "datasetId": "dataset-id",
  "datasetItemId": "item-id",
  "datasetVersionId": "snapshot-id"
}
```

For an inline test, replace `scorerId` and `versionId` with a complete `scorer` configuration. Saved updates also wrap the complete configuration in `scorer`. The preview captures real spans and correlated traces, returns the version used and `persisted: false`, and respects the scorer's evidence requirements. It may call an LLM if configured. Immutable versions remain selectable after later edits; updates now require `expectedRevision` through MCP/agent HTTP.

## 3. Evaluation lifecycle and CI

```sh
datool evals run --input @evaluation.json --wait --timeout 300
datool evals list --filter 'status = "running"'
datool evals wait run-id --timeout 300
datool evals get run-id --limit 25
datool evals target run-id --target-id target-row-id
datool evals rescore run-id --input @rescore.json --wait
datool evals compare --left-id baseline-id --right-id candidate-id --offset 0
datool evals gate candidate-id --wait --min-score 0.8 --min-pass-rate 1 \
  --baseline-id baseline-id --max-regression 0.02
```

Run reads, comparisons, waits and exports use lightweight pages by default: exact frozen inputs, outputs and results, without full trace spans. Fetch a case with `get_eval_target` (`evals target`), passing the run ID and `rows[].id` as `targetId`. Explicit `includeEvidence: true` (`--include-evidence` on get, compare or export) embeds full evidence. Responses remain capped at 8 MiB and page sizes shrink automatically; follow `nextCursor`/`nextOffset` instead of assuming every page has the requested number of rows. Wait polling always omits evidence.

`evaluation.json`:

```json
{
  "requestKey": "release-42-eval-1",
  "datasetId": "dataset-id",
  "datasetVersionId": "snapshot-id",
  "evaluatorIds": ["scorer-id"],
  "evaluatorVersionIds": { "scorer-id": "immutable-version-id" }
}
```

To execute an app, add `"mode": "connected"` and `"appId": "app-id"`. Without connected mode, dataset items need existing `sourceTraceId` values. `rescore.json` only needs a new stable `requestKey` and `evaluatorIds`, plus optional version pins. Re-scoring freezes the earlier run's evidence and does not re-invoke the app.

Starts return an asynchronous run. The same `requestKey` and payload return the same run; a changed payload conflicts. A key whose initial attempt is still starting or interrupted does not trigger automatic execution. Locate any existing run by metadata `agentRequestKey` before explicitly choosing a new key. CLI transport does not automatically retry mutations.

Gates aggregate the entire run in SQL, rather than the visible result page. Defaults require a completed, nonempty run, all expected results, zero technical errors, classified/numeric results and a 100% pass rate. `minScore` defaults to 0. Numeric scores without a pass classification need a scorer threshold or an intentional `allowUnscored` policy; a wholly unclassified run still cannot meet a pass-rate gate. Mean-score regression compares the same scorers, inputs and expected outputs. It is not a statistical significance test.

CLI exit codes: **0** successful command, **1** usage/request error, **2** failed gate, **3** wait timeout. `evals wait` reports technical completion; use `evals gate` to determine whether CI should pass. An export with a continuation cursor is a successful bounded export, not a complete population.

Jobs currently execute in the persistent Datool server process. Startup recovery marks interrupted runs failed; durable worker leasing, automatic job resumption and cancellation are outside these five foundations. Runs are capped at 10,000 targets, 100,000 results and 8 MiB of initial evidence. Split larger evaluations into explicitly bounded runs.

## 4. Dataset bulk edits and snapshots

```sh
datool datasets list --filter support
datool datasets items dataset-id --limit 50
datool datasets bulk dataset-id --input @bulk-edit.json
datool datasets snapshot dataset-id --label release-42
datool datasets snapshots dataset-id
datool datasets version dataset-id --version-id snapshot-id --limit 50
```

`bulk-edit.json`:

```json
{
  "create": [{ "input": { "question": "Hello" }, "expectedOutput": "Hello" }],
  "update": [
    { "id": "existing-item-id", "patch": { "expectedOutput": "Revised" } }
  ],
  "delete": ["obsolete-item-id"]
}
```

A batch supports 1–100 changes, checks item ownership and rolls back entirely on any failure. To protect against intervening changes, include `expectedHash` from a snapshot or prior bulk result. Existing evaluation history can prevent deleting a referenced live item.

Snapshots use canonical SHA-256 content identity and retain inputs, expected outputs, metadata and source references. Identical content returns the existing snapshot, including its original label. Snapshot content is limited to 8 MiB. Snapshot-backed evaluations still work after live dataset item edits/deletions and keep distinct results when cases share a trace. Snapshot creation does not freeze source trace evidence; each run captures evidence at start, and subsequent re-scores use that run's saved evidence.

CLI push/pull sync sidecars now include the project ID. A revision from another project or an older unscoped sidecar is not sent as the base for a write. Pull first to establish a current revision when updating an existing resource.

## 5. Analytics, navigation and export

```sh
datool metrics metadata
datool metrics query --input @query.json
datool metrics batch --input @queries.json
datool dashboards preview dashboard-id
datool views data saved-view-id --offset 0 --limit 50
datool traces resolve trace-id
datool datasets resolve support/cases
datool traces export --filter 'status = "errored"' --max-rows 10000 --out errors.ndjson
datool datasets export dataset-id --out items.ndjson
datool evals export run-id --out results.ndjson
```

Metric input is `{ "query": <semantic-query> }`; batch input is `{ "queries": [...] }`. Discover allowed measures and dimensions first. Dashboard previews run the saved queries in widget order on a consistent semantic snapshot. Saved views page by `nextOffset`; collections page by `nextCursor`.

Resolution supports exact IDs, exact names for traces/sessions/datasets/evals/saved views, and scorer slugs. Ambiguous names fail; IDs take precedence. Dashboard resolution uses IDs. Returned canonical URLs use the configured application origin and actual workspace slugs. Scorers, dashboards and saved views currently link to their collection pages and explicitly return `linkKind: "collection"`.

NDJSON exports write one page at a time to a temporary file, then publish the completed file atomically. They default to 10,000 rows, allow up to 100,000 rows, and cap output at 256 MiB. Stderr contains the path, row/byte counts, operation, inputs, `complete` and `nextCursor`. Resume a bounded export into a new file with `--cursor`. Existing files are preserved unless `--replace` is set. Live collection exports are not transaction-wide snapshots; use immutable dataset snapshots for reproducible case data. Evaluation exports contain target rows with their nested results, not one line per scorer result.

## Verification

The acceptance test exercises eight checkpoints through a tarball-installed CLI, an actual Next.js HTTP server, disposable PostgreSQL and a local connected app. It also covers OAuth project selection, consent, PKCE token exchange and MCP HTTP reads.

Run the complete acceptance workflow with Docker, Bun, Node 22.13+ and npm available:

```sh
bun run test:agent:e2e
```

This builds the local packages, installs the CLI in a temporary consumer, migrates only disposable local data, and starts a separate Next.js development server from a temporary source copy without copying `.env` files. It removes its own server, database container and temporary files on completion or failure. The test uses a fixture app and JavaScript scorers; it does not validate production deployment, browser interactions or paid LLM providers.

## Agent skills

The maintained, installable pack lives in [`skills/`](../skills/README.md) in this repository. Submit skill changes alongside the server and CLI changes they require. Operation-contract fixtures remain separate from the distributed pack.

The pack contains a general router and five focused workflows. Each specialized skill can operate with MCP or CLI and includes its own access and permission guidance.

| Skill                                                       | Workflow                                       |
| ----------------------------------------------------------- | ---------------------------------------------- |
| [datool](../skills/datool/SKILL.md)                         | Discover operations and combine workflows      |
| [datool-traces](../skills/datool-traces/SKILL.md)           | Investigate traces, spans, sessions and scores |
| [datool-scorers](../skills/datool-scorers/SKILL.md)         | Develop and preview versioned scorers          |
| [datool-datasets](../skills/datool-datasets/SKILL.md)       | Curate cases, bulk edit and freeze snapshots   |
| [datool-evaluations](../skills/datool-evaluations/SKILL.md) | Run, re-score, compare and gate evaluations    |
| [datool-analytics](../skills/datool-analytics/SKILL.md)     | Query, preview, resolve and export             |

Install the complete pack with `npx skills add vinipace/datool --skill '*'`. If you installed from the former `datool-skills` repository, run this command again with the same agent and project/global scope to switch future updates to this repository. Invoke a focused skill by name, such as `$datool-evaluations`. Installing skills does not configure credentials or deploy the server.

Run `bun run check:skills` for pack structure, local links and JSON starters. CircleCI also verifies installer discovery from the repository root and compatibility with the minimum published CLI. Separately, `bun test tests/agent-operation-fixtures.test.ts` checks `tests/fixtures/agent-operations/` against operation schemas and executes the example scorer on passing, failing, reordered-object, reordered-array and missing-context cases. These are server contract tests, not validation of the distributed skills.
