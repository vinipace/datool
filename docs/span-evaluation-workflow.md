# Production invocation evaluation

Select a completed span in the trace inspector and choose **Create dataset case**. Choose a dataset, optionally supply mapped app variables, preview the captured case, then save. The original input and observed output remain evidence; expected output defaults to null. Copying an observation into a reference is an explicit choice and does not establish that it is correct.

## Shared operations and contracts

| Operation | CLI | Behavior |
| --- | --- | --- |
| `promote_spans` | `datool datasets promote <datasetId> --input @promotion.json` | Preview by default; save 1–100 cases atomically with `preview:false` and `expectedEvidenceHash`. Requires datasets read/write and traces read. |
| `check_scorer_runtime` | `datool scorers check --input @selection.json` | Configuration only; makes no model calls and launches no sandbox. Requires scorers read. |
| `probe_scorer_runtime` | `datool scorers probe --input @probe.json` | Explicit, potentially billable execution of up to 3 pinned scorers on one representative trace/span or dataset case. Requires scorer read/write, trace read and dataset read. Retains recorded execution spans, creates no evaluation. |
| `test_scorer` | `datool scorers test --input @preview.json` | Supports optional `spanId`; dataset context uses captured case evidence. Preview returns `evaluationRunCreated:false` and `executionSpanRetained:true`. |
| `start_eval_run` | `datool evals run --input @run.json --wait` | Returns the named saved run and URL immediately. CLI prints the URL before waiting. Pin datasetVersionId and evaluatorVersionIds. |

`datool doctor --scorer-ids id,id --json` includes configuration diagnostics. Add `--probe --trace-id id [--span-id id]` only when representative execution and its possible cost are intended. CLI discovery (`datool agent tools <operation>`) supplies the exact current schema.

Promotion example:

```json
{
  "datasetId": "dataset-id",
  "preview": true,
  "spans": [{
    "traceId": "trace-id",
    "spanId": "span-id",
    "mappedInput": { "response": "Reviewed explicit app variables" }
  }]
}
```

Repeat with `preview:false` and `expectedEvidenceHash` set to the returned hash. A changed capture or changed proposal conflicts instead of silently saving different evidence. Optional `expectedHash` guards the dataset content. You can set expectedOutput explicitly or opt into copyObservedOutput; the two options are mutually exclusive.

Cases now expose `sourceSpanId`, immutable `sourceSpanEvidence`, and `observedOutput`, in addition to sourceTraceId. Scoring sees selected invocation input/output through trace.input/trace.output, with `trace.selectedSpanId` for source identity. `trace.provenance` retains source trace and ancestor timestamps/attributes without their payloads. The selected subtree excludes siblings, score spans and their descendants. The original captured input remains in sourceSpanEvidence.input when item.input contains mapped app variables. No prompt text is parsed to infer variables.

Capture is bounded to 1 MiB and 1,000 subtree spans; promotion batches and dataset/evaluation snapshots are bounded to 8 MiB. Reads validate project/trace/span identity and refuse scorer-execution selections. Two cases from the same trace remain distinct target IDs. Span-backed snapshots contain the captured evidence; legacy trace-backed cases keep existing behavior. Connected runs validate and execute the case's mapped input, while evidence scoring uses the captured invocation.

## Readiness, failures and calibration

Configuration presence, authentication/connectivity verification, and successful representative execution are separate results. The probe invokes the selected scorer's actual adapter: legacy OpenAI-compatible chat, project Gateway chat/evaluation, TypeSafe evaluation, or configured JavaScript/Python sandboxes. It has a 15-second provider execution budget per scorer (sandbox cleanup may take a further five seconds). Normal diagnostics are read-only.

Provider failures expose a safe category, allowlisted provider code, HTTP status, constrained request ID and valid Retry-After when available. Arbitrary upstream bodies and credentials are excluded. HTTP 429 means a rate limit unless the provider explicitly reports a recognized quota/credit restriction. Chat and native evaluation requests share at most one retry; if Retry-After exceeds the bounded retry wait, the request fails with that guidance rather than retrying too early. SDK retries are disabled. Evaluation admission is serialized per provider/model or sandbox language. Persistent runtime failures block later calls to that runtime in the same run; affected results remain infrastructure errors with null scores. A valid zero score does not open this circuit.

Use `examples/scorer-calibration/brand-extraction.json` for synthetic, reviewed calibration fixtures. They include a known pass, unsupported brands on an HTML loading placeholder, omissions, extra unsupported entities, and missing response evidence. For this explicit rubric, grounding rejects unsupported entities regardless of isTextMentioned/mentionCount, coverage measures omissions independently, and input validity is separate. Missing evidence yields skip rather than an invented pass. These rules are task-specific.

Record judgments as `[{"fixtureId":"known-pass","criterion":"grounding","judgment":"pass"}, ...]` and run `bun scripts/check-scorer-calibration.ts judgments.json`. Missing, duplicate, unexpected and mismatched judgments fail the check. Use a separate named calibration evaluation when testing multiple cases. Native evaluation adapters map returned choices to configured numeric scores, preserve confidence/probabilities only when returned, and supply no invented explanations.

Changing the judge model/provider requires recalibration. Keep calibration/development examples separate from untouched evaluation cases. Successful execution, purposively chosen regression examples, and agreement with old outputs do not establish production accuracy.

After judge changes, `sourceRunId` re-scores frozen evidence with new pinned scorer versions. After extractor/prompt/application-model changes, execute the connected app again; re-scoring old outputs cannot test the new app.

## Delivery and limits

Apply `0030_span_backed_cases.sql` with the usual migration process before deploying the new server. Rebuild/distribute the CLI and canonical skills together with the shared operation catalog. No production migration, deployment, provider key change or paid-provider calibration is performed by local verification.

Saved runs still use the existing persistent-process executor, without automatic restart/resume. Runtime circuits are per run, not an account-wide scheduler. Portable dataset push/pull documents continue to contain app inputs, reference outputs and metadata; use dataset operation reads/exports and snapshots to retain native captured evidence and provenance. Model support and judge quality still need calibration with the actual provider and reviewed examples.

Local reproduction: set DATOOL_TEST_DATABASE_URL to a disposable loopback PostgreSQL instance, then run `bun --no-env-file scripts/test-span-workflow-e2e.ts`. It starts an isolated Next copy, drives browser promotion, checks runtime diagnostics and a real local sandbox, creates a pinned saved run, verifies reload and mobile interaction, saves screenshots/report under artifacts/span-workflow-e2e, then removes its schema and stops its server. It requires port 3117 and cached node:22-bookworm-slim for Docker scorers.

### Local verification — September 18, 2026

- 37 unit tests passed across runtime diagnostics, chat/native provider adapters, CLI operations, scorer typings, style guards and documentation.
- 20 integration tests passed across span-backed cases, agent operations, dataset versions, connected evaluations and recorded scorer executions. After the final capture-transaction and input-validation changes, all 12 affected span/connected/scorer integration tests passed again.
- 54 Storybook checks passed for promotion, dataset inspection, scorer previews and trace selection, including loading, empty and error states.
- Typecheck, scoped ESLint, semantic style checks and `git diff --check` passed. A production build was not run.
- The real browser/API test used an isolated Next server, disposable PostgreSQL schema and actual local Docker JavaScript scorer. It promoted an exact child span with mapped input, preserved the unreviewed output and null reference, probed the runtime without creating a run, then created a pinned evaluation and verified its completed results after reload. Mobile layout, focus containment and Escape were also checked.

The reproduction command writes its report and screenshots to ignored `artifacts/span-workflow-e2e/`. These local outputs are not distributed with the source. Provider failures were mocked; live paid-provider authentication and judge quality were not claimed or tested.

## Large evidence collections and native execution

Apply additive migrations `0032_chunked_dataset_snapshots.sql` and `0033_bridge_exchange_receipts.sql` through `bun run db:migrate`. Snapshot cases are stored separately; existing JSON snapshots remain readable without rewriting historical data. Hash identity is unchanged. Each snapshot page still fits 8 MiB and can contain fewer rows than requested. Follow `nextCursor`.

Promote bounded batches (at most 100 cases and 8 MiB captured content per batch), keeping the returned evidence hash for each preview/save pair. A dataset can exceed 8 MiB of aggregate captured evidence. Snapshot-backed connected runs reference that immutable evidence and load it per case for scoring. No input, observation, reference answer, ancestor attributes or provenance is stripped. The run's compact initial manifest is still capped at 8 MiB; individual invocation, request and scorer payload limits remain in force. Large aggregate app inputs/outputs still require smaller runs.

A fresh agent can use these native commands, filling IDs from returned results and declarative JSON from `agent tools`:

```sh
datool traces list --filter 'status = completed' --limit 100
datool traces spans trace-id --limit 100
datool datasets promote dataset-id --input @promotion-preview.json
# Save the same selections with preview:false and the returned expectedEvidenceHash.
datool datasets promote dataset-id --input @promotion-save.json
datool datasets snapshot dataset-id
datool evals run --input @connected-run.json
datool evals wait run-id --timeout 300
datool evals export run-id --out results.ndjson
datool evals target run-id --target-id target-id
datool evals run --input @iteration.json
```

`connected-run.json` supplies mode `connected`, observed appId/datasetId, the snapshot's datasetVersionId, selected evaluatorIds and a stable requestKey. `iteration.json` supplies parentRunId and a new requestKey to execute those frozen cases again, or sourceRunId to re-score saved outputs. Prefer native wait/export over custom polling or pagination programs. When using MCP without a wait equivalent, pace `get_eval_run` polls and honor advertised cooldowns.

Resilient bridges negotiate protocol 2 and require an updated server. They retain the exact exchange ID/body through uncertain responses and permit two minutes of consecutive transport disruption. Sessions remain reserved for 150 seconds; dispatch, local execution (up to 60 seconds), and delivery have separate allowances. Server receipts replay empty polls and acknowledgments exactly. Late results are saved for recovery, never falsely acknowledged and discarded. Exhausted retry windows leave completion explicitly uncertain and do not replay app calls. Provider retries and runtime admission remain unchanged.
