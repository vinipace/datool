---
name: datool-scorers
description: Create, test and revise Datool JavaScript, Python or LLM scorers against real traces, including immutable versions and revision conflict handling.
---

# Develop Datool scorers

Use the configured Datool connection. See [connection and discovery](../datool/SKILL.md#connection-and-discovery) when setting up access or checking a required capability.

Read configuration/versions with scorers:read; saving needs scorers:write. test_scorer currently requires scorers:read, scorers:write, traces:read and datasets:read, even without optional dataset context.

Define what passes and which evidence is required before choosing the scorer. Keep independent criteria separate: structure/citation validity, grounding, coverage and annotation fidelity must not silently substitute for each other. For an exact JSON criterion, adapt [assets/exact-json.json](assets/exact-json.json), a create_scorer input that compares objects independently of key order while preserving array order. It is an example criterion, not a calibrated quality judge.

## Runtime and configuration

JavaScript and Python scorers use the project's configured sandbox providers, including previews and evaluations. JavaScript defines `function evaluate({ trace, datasetItem })`; Python defines `def evaluate(trace, dataset_item=None)` and receives dictionaries. Return a finite `score` between 0 and 1 and optionally `passed` and `reason`. Use `reason`, not `reasoning`, in the code's return value. Keep code self-contained; JavaScript does not accept module imports, exports or TypeScript syntax, and project modules are not mounted in the sandbox. The serialized code/trace/dataset payload is capped at 1 MiB. A saved scorer does not prove its sandbox is configured or reachable.

For a new LLM scorer, choose an available project provider/model explicitly: Gateway chat models use `provider: "vercel-ai-gateway"` with a creator/model ID; native evaluation models use a supported Gateway or `typesafe-ai` model with `modelType: "evaluation"`. Configure `messages` with system/user roles, and `choices` with unique labels and unique numeric scores. Configure `threshold` to classify numeric scores. Omitting `provider` retains the legacy server OpenAI path; it does not automatically select the project Gateway key. AI and sandbox provider credentials are configured in Project settings; MCP/CLI do not currently configure them.

Templates support `{{trace}}`, `{{input}}`, `{{output}}`, `{{expected}}`, `{{metadata}}`, `{{datasetItem}}` and nested selectors. Missing nested fields produce errors; select narrow fields instead of interpolating an entire large trace. `chainOfThought` requests an evidence-based assessment before the choice. For vision, use up to four `imagePaths` selectors such as `output.image.url`, without template braces; values must be HTTPS image URLs or supported base64 image data URLs. Use a model that supports the evidence and structured output format, then validate a real preview.

## Preview and version

```sh
datool scorers get scorer-id
datool scorers versions scorer-id
datool scorers version scorer-id --version-id immutable-version-id
datool scorers create --input @exact-json.json
datool scorers test --input @preview.json
datool scorers update scorer-id --expected-revision 2 --input @updated-scorer.json
```

The MCP equivalents are get_scorer, list_scorer_versions, get_scorer_version, create_scorer, test_scorer and update_scorer. Version lists page with nextCursor. Both create and update wrap the complete configuration in scorer; update additionally requires id and expectedRevision. On conflict, reload and reconcile instead of blindly increasing the revision.

A saved preview input is:

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

For inline configurations, replace scorerId/versionId with scorer; traceId is still required. Dataset context requires both datasetId and datasetItemId; datasetVersionId selects frozen expected outputs. Without it the preview uses the current item. The scorer executes against recorded trace evidence and returns persisted: false, meaning no score result is saved. It does record a scorer execution span, which is excluded from future scoring evidence. LLM and hosted sandbox previews can incur provider usage within the user's authorized work.

Span-backed cases run with the selected invocation subtree; legacy trace cases use their available trace evidence; requiredEvidence is no longer a scorer configuration field. Handle missing evidence in the criterion so it does not become an automatic pass. Return a passed classification or configure a numeric threshold. Execution errors produce null scores and must remain distinguishable from a valid zero. Keep LLM allowSkip intentional because gates reject skipped results by default.

Use `test_scorer` for bounded debugging of specific cases while editing a scorer. Once the goal is to assess and report judge behavior across multiple cases, use a named saved run under [judge calibration](#judge-calibration). Repeated previews do not substitute for that saved calibration record. Record immutable version IDs so later evaluations reproduce the tested scorer.

The UI also supports custom input/output samples through a separate preview endpoint; the shared test_scorer operation accepts one recorded case per call. To capture fresh evidence, use [run_app](../datool/references/apps.md) and read its returned trace before testing. For a changed judge against identical saved evidence, follow the [evaluation improvement loop](../datool-evaluations/SKILL.md#disciplined-improvement-loop).

## Runtime readiness

`check_scorer_runtime` is read-only configuration inspection for up to 10 scorer IDs; it does not call providers or establish authentication/connectivity. `probe_scorer_runtime` explicitly executes up to 3 on one representative `traceId`, optionally `spanId` and dataset context. Both accept `evaluatorVersionIds`. Probe needs scorers:read, scorers:write, traces:read and datasets:read, may incur usage, and retains execution spans without a saved evaluation. Dataset context requires both datasetId and datasetItemId. Discover these operations before use; generic CLI `agent call` works when a convenience alias is absent.

Use [span promotion and snapshots](../datool-datasets/SKILL.md#promote-production-spans-into-cases) to capture cases. A runtime error has a null score; distinguish it from a legitimate failing judgment. A persistent runtime failure blocks later requests to that runtime within the run; inspect diagnostics, provider request IDs and Retry-After before scaling. HTTP 429 alone does not establish an exhausted balance.

## Judge calibration

Calibration uses ordinary dataset cases, declared expected judgments and a named saved evaluation. Include known passes, known failures, missing-evidence examples and disagreements between criteria. Store declarations in dataset metadata or accompanying review notes; they describe expected judge decisions and do not replace the case's expectedOutput reference. Follow [evaluations](../datool-evaluations/SKILL.md) to execute the selected immutable scorer versions and retain the run URL and results. Keep a held-out set when assessing judge quality.

Compare every criterion's observed judgment with its declared expectation. A negative control correctly rejected by a judge is a calibration success even though its quality score is low; the ordinary all-pass quality gate is not a calibration-agreement gate. Report false passes, false failures, missing evidence and runtime errors separately. Recalibrate after changing a rubric, scorer revision, provider or model. Agreement with AI-labelled expectations is not independent human validation.

Native evaluation models map provider choices to configured numeric scores and may expose confidence/probabilities when returned. They do not currently return explanations; do not fabricate one or describe confidence as a calibrated probability of correctness.

## Iteration

After saving and calibrating a changed judge, follow the [evaluation improvement loop](../datool-evaluations/SKILL.md#disciplined-improvement-loop) to re-score existing outputs and compare runs. Carry forward the exact scorer version IDs from calibration.
