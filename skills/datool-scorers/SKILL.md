---
name: datool-scorers
description: Create, test and revise Datool JavaScript, Python or LLM scorers against real traces, including immutable versions and revision conflict handling.
---

# Develop Datool scorers

CLI prerequisite: `@datool/cli >=0.2.0`. Run `datool --version` and `datool doctor --json` first. Use browser login (`datool auth login`) or the API-key configuration described in the [Datool setup skill](../datool/SKILL.md).

Use connected MCP or CLI with DATOOL_BASE_URL, DATOOL_PROJECT_ID and DATOOL_API_KEY in the environment. Inspect schemas with `datool agent tools <operation>`. Read configuration/versions with scorers:read; saving needs scorers:write. test_scorer currently requires scorers:read, scorers:write, traces:read and datasets:read, even without optional dataset context.

Define what passes and which evidence is required before choosing the scorer. For an exact JSON criterion, adapt [assets/exact-json.json](assets/exact-json.json), a create_scorer input that compares objects independently of key order while preserving array order. It is an example criterion, not a calibrated quality judge.

## Runtime and configuration

JavaScript and Python scorers use the project's configured sandbox providers, including previews and evaluations. JavaScript defines `function evaluate({ trace, datasetItem })`; Python defines `def evaluate(trace, dataset_item=None)` and receives dictionaries. Return a finite `score` between 0 and 1 and optionally `passed` and `reason`. Use `reason`, not `reasoning`, in the code's return value. Keep code self-contained; JavaScript does not accept module imports, exports or TypeScript syntax, and project modules are not mounted in the sandbox. The serialized code/trace/dataset payload is capped at 1 MiB. A saved scorer does not prove its sandbox is configured or reachable.

For a new LLM scorer, choose an available project provider/model explicitly: Gateway chat models use `provider: "vercel-ai-gateway"` with a creator/model ID; direct OpenAI models use `provider: "openai"` with an unprefixed ID such as `gpt-4.1-mini` and the project OpenAI key; native evaluation models use a supported Gateway or `typesafe-ai` model with `modelType: "evaluation"`. Configure `messages` with system/user roles, and `choices` with unique labels and unique numeric scores. Configure `threshold` to classify numeric scores. Omitting `provider` retains the legacy server OpenAI path; it does not automatically select the project Gateway key. AI and sandbox provider credentials are configured in Project settings; MCP/CLI do not currently configure them.

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

Preview known passing, failing and missing-context cases. Keep a held-out evaluation set when assessing judge quality; successful execution or agreement with another model is not human validation. Record immutable version IDs so later evaluations reproduce the tested scorer.

The UI also supports custom input/output samples through a separate preview endpoint; the shared test_scorer operation does not accept those samples or a trace-ID array. Preview multiple recorded cases with separate calls, or use a version-pinned evaluation for a larger population. To capture fresh evidence, use [run_app](../datool/references/apps.md) and read its returned trace before testing. For a changed judge against identical saved evidence, follow the [re-scoring flow](../datool-evaluations/SKILL.md).

## Production span to evaluation workflow

1. Select representative production invocations and inspect exact span input/output, timestamps and model/prompt attributes. A parent trace with null output may still contain several useful invocations. Do not reconstruct inputs by guessing variables from arbitrary prompt prose.
2. Use `promote_spans` (`datool datasets promote dataset-id --input @promotion.json`) to preview exact `{traceId, spanId}` selections, then save with `preview: false` and the returned `expectedEvidenceHash`. Up to 100 promotions are atomic. `sourceSpanId` is a native case field; two spans in one trace remain separate cases. Selected descendants are captured, excluding siblings and scorer-execution subtrees, without creating production traces. Limits: 1 MiB/1,000 spans per invocation and 8 MiB per batch.
3. Keep `observedOutput` as an unreviewed observation. `expectedOutput` defaults to null. Set a reviewed reference explicitly or deliberately request `copyObservedOutput: true`; copying does not establish correctness. `mappedInput` explicitly supplies structured app variables while `sourceSpanEvidence.input` retains the capture. Scorers see captured invocation input/output; connected runs send the case's mapped input to the app and validate its schema.
4. Freeze with `create_dataset_snapshot`; record datasetVersionId/contentHash. Span-backed snapshots retain captured evidence from promotion; legacy trace-backed snapshots freeze source references, and their trace evidence is frozen when the evaluation starts.
5. Define independent criteria. Structure/citation validity, grounding, coverage and annotation fidelity must not silently substitute for each other.
6. Use `check_scorer_runtime` for configuration only. Explicitly use `probe_scorer_runtime` with up to 3 selected scorers, version pins, and one representative trace/span or dataset case to verify actual execution. Probes may incur model/sandbox usage and retain execution spans. Configuration alone proves neither authentication/connectivity nor successful execution. Calibrate known pass, fail, missing-evidence and criterion-disagreement examples before scaling.
7. When asked to run an evaluation, create a named, visible `start_eval_run` promptly and return its URL and pinned scorer versions. Preliminary previews should be small and communicated. Multi-case calibration belongs in a named saved calibration run. `test_scorer` is a preview: no evaluation run or score result is saved, but recorded-trace execution spans are retained.
8. Page through every result. Completed execution is separate from quality passing. Infrastructure failures have null scores and are not valid low quality judgments. A persistent provider/sandbox failure blocks later requests to that runtime within the run; inspect diagnostics, request ID and Retry-After. HTTP 429 alone does not mean out of credits.
9. After judge/rubric/provider/model changes, recalibrate and create a new run using `sourceRunId` with new explicit evaluatorVersionIds. This re-scores the same frozen evidence and references even after live source changes.
10. After changing the extractor, prompt, or application model, execute the connected app again on the frozen dataset. Re-scoring old outputs does not test a changed application. Keep development/calibration cases separate from untouched evaluation cases. Purposively selected regressions and agreement with old observations are not production accuracy.

## Judge calibration

Use the repository's `examples/scorer-calibration/brand-extraction.json` and `scripts/check-scorer-calibration.ts` (also shipped as [brand-extraction calibration fixtures](assets/brand-extraction-calibration.json)). Each synthetic fixture declares expected judgments independently. For the loading-placeholder fixture, known-brand context supplies no answer evidence: grounding rejects all emitted unsupported entities even with `isTextMentioned=false` or `mentionCount=0`; coverage passes because there are no supported brands omitted. Input validity separately fails. Missing response evidence produces skip for grounding and coverage under this explicit rubric. Do not generalize these choices to every extraction task.

Compare every criterion's observed judgment with its expected judgment; a runnable judge may still fail calibration. Native evaluation models map provider choices to configured numeric scores and may expose confidence/probabilities when returned. They do not currently return explanations; do not fabricate one or describe confidence as a calibrated probability of correctness. Changing the provider/model invalidates prior calibration evidence.
