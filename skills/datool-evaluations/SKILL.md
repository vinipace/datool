---
name: datool-evaluations
description: Run Datool evaluations, replay connected apps, re-score frozen evidence, compare cases and enforce CI quality gates with reproducible versions.
---

# Run and gate Datool evaluations

Use the configured Datool connection. See [connection and discovery](../datool/SKILL.md#connection-and-discovery) when setting up access or checking a required capability.

Inspect live schemas through the current connection before using newer reads, recovery or iteration fields; discovery is a contract, not proof that the credential has every required scope. Reads, comparisons and gates require evals:read. Starting requires evals:write, evals:read, traces:read, datasets:read and scorers:read.

Choose the execution mode from the user's task:

- Existing evidence: start_eval_run with traceIds, or a dataset whose items have sourceTraceId.
- One playground input: use run_app with an observed app ID, input and stable requestKey. It can run without scorers and returns a saved evaluation. See [app connections](../datool/references/apps.md) for connection setup, operation inputs and scopes.
- Fresh dataset execution: discover the app with list_apps/get_app (apps:read), verify its input schema and availability, then use mode connected, an observed appId, datasetId and datasetVersionId from the chosen snapshot. Both outbound local bridges and registered HTTP webhooks use this path. Adapt [assets/connected-run.json](assets/connected-run.json). Provide evaluatorIds for a new selection; a parent/source run can supply its scorer selection. App-default scorers are not inherited.
- Application, prompt or model iteration on an existing run: use parentRunId to execute the app again on that run's frozen case subset and references. Follow the [improvement loop](#disciplined-improvement-loop) to control which prompt/scorer versions change.
- Judge changes on the same evidence: use sourceRunId and the chosen evaluators. Adapt [assets/rescore.json](assets/rescore.json). Do not combine sourceRunId with a new dataset, trace selector or connected mode. Re-scoring does not invoke the app again.

`datasetVersionId` selects prepared frozen cases. Omitting it for a fresh dataset run selects the live dataset at run creation; use that only when intended. Creating a snapshot does not select it automatically. Parent/source runs inherit frozen cases and references, so do not add a new dataset selection to those inputs.

Prompt and scorer version choices are independent of dataset snapshot selection. Ordinary new runs may omit prompt/scorer pins to use latest published prompts and active scorers, then record the resolved versions. Controlled comparisons must hold every version outside the intended change constant.

For connected experiments, optionally add `inputOverrides` (a JSON object) to
`start_eval_run`/`evals run`. Keys shallowly replace each case input's values;
nested objects/arrays replace whole values and null is literal. Every selected
case input must be an object when overrides are present. Validate effective
inputs against the app's schema; model/prompt keys are app-defined, not Datool
magic. Original cases and expected outputs stay unchanged. The run freezes
`trace.input` and `metadata.inputOverrides`; only effective input goes to the
app, never case metadata or expected answers. Changed overrides require a new
requestKey. Overrides are forbidden with sourceRunId, trace scoring or single
app invocations; re-scoring retains the source evidence and override provenance.
Comparison rows expose `datasetCaseId` even when `datasetItemId` is null, so frozen
cases still pair across model/prompt variants. Confirm server support with live
operation discovery. See [the override starter](assets/input-overrides-run.json).

Use existing authorization for app calls and LLM judge costs. Keep one stable requestKey for a logical start; retry uncertain delivery with the same key and identical inputs. Changed inputs conflict. For a still-starting or interrupted request, inspect list_eval_runs using metadata.agentRequestKey before explicitly deciding whether to create a new request. Do not silently generate a new key to bypass a conflict.

Before a heavy campaign, follow [runtime readiness](../datool-scorers/SKILL.md#runtime-readiness) and [judge calibration](../datool-scorers/SKILL.md#judge-calibration) for the intended scorers. Reuse applicable recorded checks for unchanged versions/runtimes. Check that dataset inputs match the app schema and expectedOutput contains the judge's intended reference answer. Local agent handlers receive the messages array, but their dataset input remains an object containing messages. Connected concurrency defaults to 4 and is bounded to 1–16 per run; lower it for provider limits. Dataset/scorer versions freeze cases and judges, not local handler code or the remote endpoint implementation. Record the tested app revision and code commit/deployment in run metadata, and keep the implementation stable while the run executes.

When asked to run an evaluation, create a named saved run and return its URL and resolved scorer versions promptly. Keep preliminary debugging previews bounded and communicate them; use a named saved run for multi-case calibration results.

## Run results and exports

```sh
datool evals run --input @connected-run.json --wait --timeout 300
datool evals wait run-id --timeout 300
datool evals export run-id --out results.ndjson
datool evals get run-id --limit 50
datool evals target run-id --target-id target-row-id
datool agent call start_eval_run --input @rescore.json
datool evals compare --left-id baseline-id --right-id candidate-id --offset 0
datool agent call gate_eval_run --input @gate.json
```

When a CLI is configured for the same project, prefer native `evals wait` and `evals export` over custom polling or pagination programs. Export retains saved reasonings and errors for the exported rows; verify `complete` and `nextCursor` in its stderr manifest using the [export completeness and limits](../datool-analytics/SKILL.md#export-completeness-and-limits) procedure. With MCP and no equivalent wait operation, pace `get_eval_run` polling, honor advertised retry timing, and follow nextCursor to inspect all targets/results. A completed status means execution finished, not that quality passed. compare_eval_runs uses nextOffset. Record the actual resolved versions used, run ID, case count and evidence origin.

Run reads and comparisons return exact frozen inputs/outputs and results without full spans by default. Use `get_eval_target` with `{id: runId, targetId: row.id}` for one case's saved evidence and scorer spans; the CLI equivalent is `evals target`. Older CLI versions can use `agent call get_eval_target --input` with that JSON. Explicit `includeEvidence: true` (`--include-evidence` for get, compare or export) embeds full evidence. Batches shrink automatically to fit 8 MiB, so always follow the returned nextCursor/nextOffset even when the page has fewer rows than requested. Waits remain lightweight.

Adapt [assets/gate.json](assets/gate.json) to the user's quality thresholds. gate_eval_run aggregates the entire run. Defaults reject incomplete, empty, missing, skipped/unclassified and technically failed results; minPassRate defaults to 1 and minScore to 0. Define scorer thresholds or passed classifications. allowUnscored does not make a wholly unclassified run pass. Baseline gates require the same scorer IDs and immutable versions, comparable case populations, inputs and expected outputs; mean-score regression is not a significance test.

CLI exit codes are 0 for command success, 1 for usage/request failure, 2 for a failed gate, and 3 for a wait timeout. Preserve the gate's exit code in CI. A wait alone is insufficient to gate quality.

Limits are 10,000 targets, 100,000 results and 8 MiB of initial run manifest. Servers with per-case snapshot storage allow aggregate captured source evidence above 8 MiB when the run selects that snapshot. Split work exceeding the remaining limits into explicitly bounded runs. Connection and scorer payload limits also apply, so passing the run-level size check does not establish that every case can execute. For interrupted work, follow [recovery and cancellation](#recovery-and-cancellation).

For agent findings and ratings, use the [AI-labelled review workflow](../datool/references/reviews.md). API-key and OAuth reviews retain authenticated provenance and separate AI completion counts. A completed AI review is not human-verified ground truth and does not update dataset expected outputs.

## Production evidence and managed prompts

For source-span promotion, reviewed references and frozen datasets, follow [span promotion and snapshots](../datool-datasets/SKILL.md#promote-production-spans-into-cases).

For connected SDK applications, use top-level `promptOverrides` keyed by published slug, with optional `version` and `model`. Adapt [the prompt override starter](assets/prompt-overrides-run.json). Keep managed prompt controls out of dataset inputs. Confirm installed SDK/bridge support and the live schema. The SDK credential additionally needs `prompts:read`, `evals:read` and `traces:write`; HTTP handlers install the scope with `withDatoolRequest`.

Datool snapshots all published defaults before execution, including lazy discoveries. Inspect `metadata.promptConfig` and `Prompt: <slug>` spans for baseline and actual resolutions. Changed overrides require a new requestKey; re-scoring accepts no overrides. Read [managed prompts](../datool/references/prompts.md) for scope, precedence and cache behavior.

## Disciplined improvement loop

Use existing runs as iteration history. Discover current `start_eval_run`, `get_eval_run` and `compare_eval_runs` schemas before relying on newer fields; if absent, report the compatibility gap and use supported existing primitives. For controlled prompt/model iterations, adapt [the parent-run starter](assets/iterate-run.json), which holds recorded prompt/scorer versions while changing one prompt model.

1. Retrieve saved results with the [run results and exports](#run-results-and-exports) procedure, including failures and errors. Inspect each candidate defect's frozen evidence with `get_eval_target`; read the judge's reasoning and exact scorer revision. Runtime failures and incomplete delivery are execution problems, not evidence of a product defect.
2. Verify each judge claim against the source. Mark unsupported claims, missing evidence and incorrect references separately. Keep AI-authored findings labelled AI; never convert an agent opinion into human verification by changing metadata.
3. Group verified defects by shared cause, retaining the run, target, source span and scorer references. Explanations and a small working table are sufficient; do not infer structured factual findings from prose automatically.
4. Change one cause at a time. For application/prompt/model changes, start with `parentRunId`; it reuses frozen cases and references, executes the app again and records resolved versions plus `metadata.configurationChanges`. Latest published prompts and active scorer versions are the default. Select `useRecordedVersions: true` to hold the recorded judges and prompt versions constant, then override only the prompt/model under test. For judge changes, save and calibrate the new version, then use `sourceRunId` with explicit `evaluatorVersionIds`; the saved outputs and references stay fixed and the app never executes. For latest prompts with unchanged judges, copy the prior run's `evaluatorVersionIds` and omit useRecordedVersions. Optional individual pins also work. `parentRunId` cannot accompany a new dataset/trace selection or `sourceRunId`; it preserves the original subset, references and case identities. Recorded prompt/judge versions do not restore application code.
5. Compare via the existing `compare_eval_runs`, following `nextOffset`. Its `configurationChanges` separates extractor settings from judge revisions; rows retain actual inputs and references. A change in judges means score movement cannot be attributed only to the application. For an application baseline, verify identical scorer IDs AND version IDs, inputs and expected outputs before gating. Updated servers enforce scorer versions; older gates may check only IDs. Viewing a comparison remains allowed. For a deliberate judge change, report calibration agreement separately from application score changes.
6. Re-run the verified regression cases first, then the untouched evaluation cases with the same references and judges. Report regressions, remaining defects and denominators. Improvement on selected cases does not establish production accuracy.
7. Keep expectedOutput fixed while measuring an application change. Handle proposed corrections through [reviewed reference corrections](../datool-datasets/SKILL.md#reviewed-reference-corrections), then compare the resulting snapshot explicitly as a reference change; old runs remain frozen.

## Recovery and cancellation

Runs execute in the persistent server process. Discover `recover_eval_run` and `cancel_eval_run` before using them. Cancellation requires evals:read and evals:write. Recovery additionally requires traces:read, datasets:read, scorers:read and apps:read. Use recovery after a worker lease expires or a terminal runtime failure; cancelled runs require an explicit new run.

When installed CLI help advertises them, use `datool evals recover run-id` and `datool evals cancel run-id`. Otherwise use `datool agent call recover_eval_run --input '{"id":"observed-run-id"}'` or the corresponding cancel operation. Published CLI 0.3.0 needs these generic calls. Read `get_eval_run` after cancellation because older wait loops may not recognize cancelled as terminal. A CLI wait timeout stops waiting, not execution; continue with wait/get using the same run ID. Bridge execution and transport deadlines are separate; see [bridge timing and recovery](../datool/references/apps.md#bridge-timing-and-recovery).

A case exposes its execution stage and error in ordinary run reads. `invoking` means the app call was dispatched; `awaiting_delivery` means its output is saved but trace evidence is still arriving; `scoring` means the judges are running. Recovery preserves completed judgments (including legitimate quality failures), retries missing/error judgments and rechecks evidence delivery without rerunning a completed app. It dispatches only provably queued calls against the recorded app definition, blocks ambiguous completion and rejects a live worker. Cancel fences later judgment writes; an already dispatched app may finish. Inspect run/target stages before choosing recovery, re-scoring or an explicit fresh application run.
