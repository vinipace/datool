# Run recovery and iteration

Runs remain the saved unit of work. Select latest normally: run creation freezes actual cases, prompt settings and scorer versions automatically. No separately managed experiment, calibration, reference or reporting entity is required.

## Existing operations

`start_eval_run` / `datool evals run` accepts `parentRunId` for a fresh application execution on the parent's frozen cases and references. It inherits the app, scorer selection and input/model settings, resolves latest published prompt and active scorer versions, and records the resolved `evaluatorVersionIds`, `metadata.promptConfig`, `metadata.parentRunId` and `metadata.configurationChanges`. Changes are classified as `extractor` or `judge`. This path keeps the parent's case subset even if live dataset items change or disappear. Do not combine parentRunId with new target selections.

Use `useRecordedVersions: true` to reproduce recorded prompt and scorer revisions, then supply only the specific prompt/model overrides under test. `evaluatorVersionIds` can pin individual scorers. App source is not a versioned execution artifact: local connections report a best-effort Git revision, dirty flag and fingerprint, excluding ignored files/dependencies. Remote code identity is unknown unless declared. Restoring recorded prompt/judge settings does not restore application code.

`sourceRunId` retains frozen outputs and references and runs only judges. Latest scorer versions are the default; `useRecordedVersions` holds those recorded in the source run. Prompt/input overrides are rejected for re-scoring.

```json
{
  "parentRunId": "observed-run-id",
  "useRecordedVersions": true,
  "promptOverrides": { "observed-prompt-slug": { "model": "provider/model" } },
  "requestKey": "unique-logical-iteration"
}
```

Reuse requestKey for an uncertain retry of the same start. A changed configuration requires a new logical request. The run and request claim are linked atomically before dispatch.

`get_eval_run` and `compare_eval_runs` remain the bounded reads; follow nextCursor / nextOffset. Existing lightweight responses preserve exact inputs, outputs, expectations and reasons; retrieve full evidence with get_eval_target. Comparison responses add configurationChanges, while paired cases expose inputChanged/referenceChanged. A judge change remains viewable but cannot pass a quality baseline gate: the gate checks exact scorer IDs AND version IDs as well as inputs/references and population. A mean-score gate is not a statistical significance test.

The existing Run app again and Re-score actions expose latest versus recorded versions, plus latest prompts with recorded judges for controlled application comparisons. App iteration opens the comparison against its parent automatically. No new report API is introduced.

## Execution and recovery

Migration 0031 adds target checkpoints and a worker-owner token to existing leases. Run reads expose aggregate execution state plus each case's stage/error:

- queued: app execution has not been dispatched;
- invoking: app call dispatched, output not yet confirmed;
- awaiting_delivery: app output saved; internal trace delivery incomplete;
- capturing: collecting evidence for scoring;
- scoring: running judges on frozen evidence;
- completed: target execution complete (a quality failure still counts as completed);
- error: technical execution failure;
- blocked: app completion is ambiguous and redispatch is unsafe.

Expired workers reach a terminal completed/partial/failed state according to persisted checkpoints, retaining original evidence. A live lease excludes recovery. `recover_eval_run` / `evals recover` claims expired/terminal work with a new fenced owner, retains completed judgments, reuses completed scorer spans whose result write was interrupted, and retries missing/error judgments. It rechecks delayed trace delivery without repeating the app. Only provably queued calls may execute, and their app definition/fingerprint must match the recorded configuration. Ambiguous calls remain blocked until a durable root/bridge output can be recovered or the user explicitly starts a new app run.

`cancel_eval_run` / `evals cancel` stops scheduling and fences late checkpoint/result writes. Already dispatched app/provider calls may finish and retain trace evidence. Cancellation is terminal; use an explicit new run afterward. A CLI wait timeout does not cancel the run.

This is a persistent-process executor, not a distributed queue or exactly-once external side-effect guarantee. Execution spans remain evidence of attempts. Recovery does not turn an uncertain HTTP side effect into a safe automatic retry.

## Improvement workflow and verification

The evaluation, scorer and dataset skills cover evidence verification, grouping causes, one-change iterations, regression/untouched-case checks, ordinary calibration datasets and review provenance. Reference corrections use existing reviews, optimistic dataset edits and snapshots, separately from application comparisons.

Local verification uses `tests/eval-recovery-iteration.test.ts` and `scripts/test-eval-run-iteration-e2e.ts`, alongside existing evaluation/relay/prompt/CLI suites. The E2E script starts a disposable local database schema, real Next routes, a local app/judge fixture, the built CLI and a real HTTP MCP client. `--keep` leaves the fixture alive for browser checks until interrupted; it never connects to hosted project data.
