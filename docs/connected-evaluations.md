# Connected evaluations

Datool runs dataset cases against a connected app and scores their traces. A plain handler needs no tracing SDK: Datool records input, output, duration, and errors as an invocation trace. Connect an app using the existing `datool connect` command, then choose **Run dataset** in Evals, a dataset detail page, or a playground node.

The app runs once per selected case, with a default concurrency of four. Each case snapshots its input, expected output, metadata, scorer version, and the trace evidence used for scoring. App failures remain visible without stopping other cases. The detail page updates while work runs. **Re-score saved traces** uses the frozen evidence and current scorer versions without invoking the app. **Run app again** invokes the app using the current dataset and scorer definitions.

JavaScript scorers use `evaluate({ trace, datasetItem })` in the existing sandbox. Create/edit them in Scorers; the same definitions appear in the playground and eval picker. Existing evaluator IDs and history remain usable. LLM scorers execute on the Datool server using `OPENAI_API_KEY` and strict choice/reason responses. Templates can reference `{{trace}}`, `{{input}}`, `{{output}}`, `{{expected}}`, and nested fields. Judge prompts, model, usage, and estimated cost are saved with the result. Failed or skipped judges have a null score; they never silently become zero.

## Optional internal tracing

The Datool span processor attaches spans to the invocation trace when a connected bridge supplies its context. Standalone HTTP adapters can use `withDatoolRequest` after authenticating the request. Correlated older traces are exposed as `trace.linkedTraces` in the immutable scoring snapshot. No model or usage data is invented for uninstrumented calls.

A connected app can declare `internalTracing: true` and provide `flushTelemetry: () => processor.forceFlush()` in its local configuration. The bridge acknowledges completion only after that hook succeeds. Scoring waits up to 20 seconds for declared telemetry. Evidence coverage is recorded as `invocation-only`, `unknown`, `incomplete`, or `complete`; observed ended spans alone do not establish completeness. A scorer can require internal spans or confirmed complete telemetry, with an explicit skipped/error outcome for missing evidence.

## Optional resource files

Files are import/export artifacts. Runtime execution uses the Datool database, not the original files.

```sh
datool datasets push ./cases.json --dry-run
datool datasets push ./cases.json
datool datasets pull example/cases --out ./cases.json
datool scorers push ./scorer.json
datool scorers pull example-check --out ./scorer.json
```

Both command groups support `--datool`/`DATOOL_URL` and the existing `DATOOL_API_KEY`. A `.datool-sync.json` sidecar tracks the remote revision and local content hash. Stale pushes conflict. Pull refuses to overwrite unsynced local changes unless `--replace` is explicit. Dataset push retains omitted cases and never removes them implicitly.

Dataset format:

```json
{
  "format": 1,
  "kind": "dataset",
  "key": "example/cases",
  "description": "Example cases",
  "items": [
    { "key": "one", "input": { "value": 1 }, "expectedOutput": { "value": 1 }, "metadata": {} }
  ]
}
```

Scorer format:

```json
{
  "format": 1,
  "kind": "scorer",
  "key": "example-check",
  "config": {
    "name": "Example check",
    "slug": "example-check",
    "type": "javascript",
    "code": "function evaluate({ trace, datasetItem }) { return { score: trace.output.value === datasetItem.expectedOutput.value ? 1 : 0 }; }"
  }
}
```

The portable case key preserves identity across edits. `sourceTraceId` is not required. Scorer files must be self-contained; importing application modules inside sandboxed JavaScript is unsupported.

## Runtime and verification

This runs in the existing local, persistent Datool server process. A process restart marks unfinished runs failed and does not repeat app calls. This is not a serverless job scheduler or hosted production ingestion service.

For isolated verification, `DATOOL_DATA_DIR` selects a separate local data directory and `DATOOL_DIST_DIR` selects an alternate Next build directory. The initial migration `migrations/0001_initial.sql` includes executable scorer configurations and immutable target snapshots. Generated execution evidence is kept locally under ignored `artifacts/`; use synthetic cases for shared examples.

## Production span cases

See [Production invocation evaluation](./span-evaluation-workflow.md) for native span promotion, explicit input mapping, observations versus references, runtime readiness, saved evaluations, and judge calibration. Span-backed cases use frozen selected invocation evidence and keep navigation to the original span.

## Run-level input overrides

Connected dataset evaluations accept an optional `inputOverrides` JSON object in
`POST /api/evals`, MCP `start_eval_run`, and `datool evals run --input`. The **Run
dataset** dialog exposes the same optional JSON field. For example:

```json
{
  "mode": "connected",
  "appId": "brand-extractor",
  "datasetId": "dataset-id",
  "datasetVersionId": "snapshot-id",
  "evaluatorIds": ["scorer-id"],
  "requestKey": "brand-model-b-prompt-v2",
  "inputOverrides": {
    "model": "provider/model",
    "promptSlug": "brand-extraction",
    "promptVersion": 2,
    "discoveryPromptSlug": "brand-discovery",
    "discoveryPromptVersion": 3
  }
}
```

`requestKey` belongs to the CLI/MCP start operation; omit it for `POST /api/evals`.
The application defines these keys and their types in its input schema. Datool
passes them through; it does not resolve model or prompt versions itself.

- Effective input is a **shallow merge** of `case.input` and `inputOverrides`.
  Override keys win. Nested objects and arrays replace whole values. `null` is a
  literal value, not deletion. An omitted field preserves the case value.
- When overrides are supplied (including `{}`), every selected case input must
  be an object. All effective inputs are validated against the frozen app schema
  before any invocation traces or app calls are created. Invalid input rejects
  the entire start. Omitting overrides retains existing behavior.
- Only input fields go to the app. Expected outputs and case metadata remain
  scorer references and are never added to the invocation payload.
- Original cases stay immutable in the run snapshots; effective inputs are
  frozen in each invocation trace. `metadata.inputOverrides` records the actual
  run overrides and takes precedence over caller-supplied metadata of that name.
  Dataset contents and snapshots are not edited.
- Overrides require `mode: "connected"` and `datasetId`; `datasetVersionId` and
  `datasetItemIds` can narrow the frozen population. Trace scoring, single app
  calls and `sourceRunId` cannot supply overrides. Re-scoring retains the source
  run's effective evidence, references and override provenance without app calls.
- Overrides participate in CLI/MCP idempotency: the same `requestKey` and payload
  return the same run; a changed override conflicts. Use a new request key for a
  new experiment.
- Comparisons pair by case identity before trace or input. Returned rows include
  `datasetCaseId`, the frozen identity even when the live `datasetItemId` foreign
  key is null. Thus changed model/prompt inputs still pair the same snapshot
  cases, including cases deleted from the live dataset. Duplicate identities
  remain ambiguous and are not arbitrarily paired.

## Managed prompts

Use `promptOverrides: { "brand-extraction": { version: 2, model: "openai/gpt-4.1-mini" } }` for native SDK prompt experiments. The server freezes every published project prompt at run creation, including defaults and lazy discoveries. Overrides are separate from `inputOverrides` and expected outputs; they participate in request-key identity. Re-scoring uses frozen evidence/configuration and accepts no new overrides. See [exact SDK and snapshot semantics](./managed-prompts.md#native-sdk).


See [run recovery and iteration](./eval-run-iteration.md) for safe recovery, running again from frozen cases and comparing resolved application and judge settings.
