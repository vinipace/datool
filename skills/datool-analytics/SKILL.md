---
name: datool-analytics
description: Query Datool semantic metrics, author MDX reports, inspect dashboard and saved-view results, resolve resource links and export paginated traces, datasets or evaluation data.
---

# Query Datool data and create reports

Use the configured Datool connection. See [connection and discovery](../datool/SKILL.md#connection-and-discovery) when setting up access or checking a required capability. Server and CLI releases are independent: discover the live catalog instead of assuming all sources or client retries are deployed.

Metrics need metrics:read; dashboard previews also need dashboards:read. Saved-view data requires views:read, traces:read and evals:read.

```sh
datool metrics metadata
datool metrics query --input @assets/trace-count.json
datool metrics batch --input @assets/five-source-counts.json
datool metrics query --input @assets/spans-cost-by-model.json
datool metrics query --input @assets/scores-by-definition.json
datool dashboards preview dashboard-id
datool views data saved-view-id --offset 0 --limit 50
datool traces resolve trace-id
datool datasets resolve support/cases
datool traces export --filter 'status = "errored"' --max-rows 10000 --out errors.ndjson
datool datasets export dataset-id --out items.ndjson
datool evals export run-id --out results.ndjson
```

Example paths are relative to this skill's directory. Replace dates and resource IDs before execution. Use [trace-count.json](assets/trace-count.json), [five-source-counts.json](assets/five-source-counts.json), [spans-cost-by-model.json](assets/spans-cost-by-model.json) and [scores-by-definition.json](assets/scores-by-definition.json) as input shapes, not fixed reporting windows.

## Choose the source by what one row represents

Call `get_metrics_metadata` before constructing `query_metrics` or `batch_metrics`. Prefer models with `source.visibility = primary` for new queries. Display `source.title` to users; use the model/member identifiers from the catalog in API inputs.

| Source | API model | One fact | Bounded time dimension | Example measure |
| --- | --- | --- | --- | --- |
| Traces | `traces` | One request | `traces.startedAt` | `traces.count` |
| Spans | `spans` | One recorded execution step | `spans.startedAt` | `spans.spanCount`, `spans.costUsd` |
| Evaluation Runs | `evalRuns` | One evaluation batch | `evalRuns.createdAt` | `evalRuns.count` |
| Evaluation Results | `evalResults` | One scorer execution against a case | `evalResults.completedAt` | `evalResults.executionCount`, `evalResults.meanScore` |
| Scores | `scoreValues` | One current saved rating | `scoreValues.recordedAt` | `scoreValues.count`, `scoreValues.meanValue` |

Evaluation Results describe executions, including failures or missing scores; Scores combine saved ratings from scorers, imports and reviews. A rating is not another scorer execution. Scores preserve original value types and scales. Review ratings represent their current state; edits replace the value and recorded time, so these queries do not reconstruct review edit history.

The sources have different metrics and dimensions because they count different facts. Inspect each member's `definition`, `factIdentity`, `eventTime`, `denominator`, `eligiblePopulation`, `attribution`, `overlap` and `limitations` when present. Check dimension `groupable`, `filterOperators`, `filterValueType`, `cardinality` and `multiplicity`; use typed JSON-path filters only where supported. A dimension available on Spans is not automatically available on Evaluation Results. Inspect `source.unavailable` for missing telemetry or context and explain the limitation instead of inventing an equivalent metric.

For LLM cost by model, query `spans.costUsd` grouped by `spans.model`, ordered by cost descending. Zero cost is a known value; null is unknown. For evaluation quality comparisons, use Evaluation Results and the saved evaluated-case context; keep scorer definitions/versions comparable. Workload model attribution does not establish which model the scorer itself used. Do not infer scorer duration from result timestamps or combine workload and scorer cost without measured attribution.

For numeric Scores measures marked `requiresDefinition`, discover `scoreValues.definitionId` values, then filter to one compatible definition or group by that dimension. Grouping only by score name, origin, model or value type does not establish a compatible scale. Imports without declared definitions have individual unknown scales. Do not suppress the mixed-definition validation error or average unrelated ratings together. Multi-model attribution and multi-select categories can overlap: do not sum their grouped counts as an overall distinct total.

## Preserve existing queries and report query limits

Legacy namespaces remain supported. `logs` is a legacy span/usage source; `scores` is a legacy scorer-results source, **not** the new Scores ratings model. `evalQuality` contains attributed evaluation results; `agents` and `workflows` retain invocation metrics. Keep saved legacy queries intact. A catalog `source.replacement` is migration guidance, not permission to replace prefixes: definitions, populations and event times can change. Inspect and preview any requested migration before saving it. If a source/member is absent from the live catalog, report that deployment's capability gap rather than inventing a replacement.

Queries use `{query: ...}`; batches use `{queries: [...]}` with 1–40 queries. Use catalog members and semantic filters, not SQL. Select one bounded time dimension from that source, respecting `maxWindowDays` and `maxLimit`. Record the reporting window/timezone, result annotations, `meta.quality` warnings/limitations and pagination before presenting aggregates as complete. Distinguish technical run completion, explicit check pass rate and score averages; each has its own eligible population and denominator.

`batch_metrics` queries share one consistent snapshot. `preview_dashboard` executes stored widget queries with their saved date windows; it does not automatically adopt the browser's current rolling window or unsaved filters. Comparisons expand into additional queries. Each batch of at most 40 expanded queries shares a snapshot; larger previews span multiple snapshots. Inspect each result's `meta.asOf` and preserve widget/comparison ordering. `get_dashboard` reads configuration only. Saved-view rows use nextOffset. Saved selector views and custom eval-run display views are different resource types; use `get_saved_view_data` for the former.

## Draft, review and publish reports

For an evaluation comparison, progress readout or saved analysis with narrative, follow [the MDX report workflow](references/reports.md). Start with `get_report_authoring_guide` for component props, a recipe and the validation workflow. Keep narrative/layout in `report.mdx` and metadata, named queries and evidence bindings in `report.data.json`. Validate, create a private draft, and inspect its desktop/mobile rendering. Users and agents edit the same document; prose/layout saves preserve captured evidence, and changed queries need explicit refresh. Publication locks the reviewed revision; public-link sharing is a separate authorized action.

## Handle busy reads without replaying writes

Direct MCP calls can return `isError: true` with JSON text containing `code: READ_BUSY` and `details.retryAfterSeconds`; this is a tool error even when the MCP transport succeeded. Honor the server delay, add bounded exponential backoff with jitter, and retry the identical read. Use at most four retries and a 15-second retry-start budget; stop on cancellation or when the next delay cannot fit. If still busy, report it rather than interpreting failure as empty data. Do not retry validation or authorization errors this way.

Apply this policy only to analytics reads (`get_metrics_metadata`, `query_metrics`, `batch_metrics`, `preview_dashboard`, `list_report_templates`, `get_report_template`, `get_report_recipe`, `get_report_components`, `get_report_authoring_guide`, `validate_report`, `list_reports`, `get_report`, `resolve_report`). CLI releases with analytics read retries handle transient failures internally; verify the installed release before adding an outer retry loop. Never turn a generic `agent call` or MCP write into an automatic replay, including dashboard updates, scorer execution or evaluation creation. Keep mutations single-shot and use their documented idempotency/reconciliation flow after uncertain delivery.

## Resolve links and export complete evidence

Use resolve_* operations to obtain canonical workspace URLs. IDs take precedence; supported name lookups are exact and ambiguity fails. Scorers also resolve by slug; dashboards resolve by ID. A returned linkKind of collection explicitly means the URL opens a collection, so do not invent a detail route.

## Export completeness and limits

Exports stream NDJSON pages into an atomic output file. Dataset IDs export items; evaluation run IDs export target rows with nested results, saved reasonings and errors. Without an ID these commands export collection summaries. Check the stderr manifest for `complete: true` and `nextCursor: null` before claiming all requested rows were exported. `complete: false` with a nextCursor is a bounded partial export, even when the command exits successfully. Resume with `--cursor` into a new file using the same selection and options; preserve each manifest and combine the parts when assessing coverage.

The default row cap is 10,000; `--max-rows` accepts up to 100,000. Exceeding the 256 MiB byte cap fails the export without publishing its temporary file. Reduce the requested rows per part, then follow continuation cursors. When full spans are unnecessary, compact rows plus selected target reads can reduce export size. Existing files require an intentional `--replace`.

A successful export command is not proof of complete coverage. Live pagination observes a changing collection, not a database-wide immutable snapshot. Use dataset snapshots for frozen cases and report any partial pages or query caps. Keep unknown measures distinct from zero and distinguish technical run completion from evaluation quality in reports.
