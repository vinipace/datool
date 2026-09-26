# Dashboards

Open `/dashboards` from the sidebar. The collection reuses the logs table. Choose **New dashboard** to select **Blank dashboard** or browse the template library, name the dashboard, then choose **Create dashboard**. The library includes **Weekly health**, **LLM overview**, **Cost and usage**, **Latency and responsiveness**, and **Evaluations**. Each template creates an independent, fully editable configuration with a rolling seven-day window and queries against the current project. Browsing or cancelling creates nothing; a failed creation preserves the selection and name for retry. Template definitions live in `src/lib/tracer/dashboard-templates.ts` and reuse the existing metric presets. Edit any dashboard using the visual builder or configuration JSON. The **Use logs layout** preset supplies Spans, Latency, Total LLM cost, Token count, and Time to first token; an expensive-traces ranking can sit beside them. Topics is omitted.

The dashboard header's **…** menu contains save status, **Edit dashboard / Done editing**, **Clone dashboard**, and **Delete dashboard**. Editing reveals the name and Add widget controls; save errors remain visible with retry or conflict recovery. Delete keeps its confirmation dialog and returns keyboard focus to the header menu on cancel.

## Template library

Templates combine four summary tiles with trends, breakdowns, and ranked tables. Each remains below the 20-widget limit and uses the existing snapshot query planner for totals, daily history, and previous-period comparisons.

| Template | Widgets | Includes |
| --- | --- | --- |
| Weekly health | 14 | Failures, affected users, error types, trace statuses, traffic, and latency trends |
| LLM overview | 12 | Traffic, LLM calls, cost, failure rate, timing, usage, and request performance |
| Cost and usage | 11 | Cost and token totals, cached tokens, cost by model over time, spend and usage by LLM call name and request |
| Latency and responsiveness | 10 | Mean/P95 latency and TTFT, slow requests, first-token timing by span, and operation latency |
| Evaluations | 16 | Run activity/status, executions, explicit pass rates, errors, failed checks, and results by evaluator/version, agent, workflow, and run |

Evaluations uses `evalRuns.createdAt` for run activity and `evalResults.completedAt` for result activity. The date filter applies to both clocks; a result can complete in the selected period even if its run started earlier. Pass rates include only explicit pass/fail outcomes; technical errors have their own metric. Compare mean scores within an evaluator version. Run coverage uses saved cases and frozen scorers; insufficient historical linkage yields unavailable coverage. Non-date trace filters are unsupported by these eval models and retain the existing visible validation error.

Agent and workflow widgets use saved evaluation-time attribution. `evalResults.groupType`, `evalResults.groupName`, and `evalResults.groupVersion` are available for grouping and filtering in the widget editor. Each execution counts once per displayed group, even with repeated calls or multiple versions collapsed into one name. A case involving multiple groups contributes to each, so group counts can overlap and must not be summed into a global total. These are results for cases involving an agent or workflow, not proof that a specific span was independently scored. Historical results without saved attribution remain in global totals and the missing-attribution group. Existing `scores.*` queries preserve their older current-membership semantics.

Template improvements apply when creating a new dashboard; saved configurations remain independently editable. Cost rankings use eligible LLM span quotes and exclude zero-cost groups. First-token and operation rankings retain measured zeroes and omit missing timings.

## Weekly health

**Weekly health** in the template library saves an editable dashboard in the current project using registered metrics. It opens with a rolling seven-day filter and shows total traces, failed traces, trace failure rate, failed spans, daily failures, failing request names, recurring error messages and types, affected user IDs, and failing span names. Tables rank failures descending and paginate after aggregation. The widget editor exposes sorting for custom tables and bar charts.

`traces.erroredCount` counts each persisted trace with status `errored` once. `spans.erroredCount` counts individual failed spans, including nested failures and errors recovered by retries. These are different populations and must not be added together. Both models expose `errorRate = errored / (completed + errored)`, excluding running and cancelled records; the rate stays null if the denominator is zero. Spans metrics use span start time; traces use trace start time. The shared period and filters apply to every widget.

Error types read span attributes `error.type`, `error.name`, then `exception.type`. Error messages read `error.message`, then `exception.message`. Messages group by exact text, without inferred categorization. User IDs read trace attributes `user.id`, `enduser.id`, then `userId`; they identify instrumented application users, not Datool workspace members. Missing dimensions display **Not recorded**. Failure rankings omit zero-failure groups while keeping the complete denominator for trace rates.

`defaultWindowDays` optionally sets the dashboard's initial rolling period (1–90 days) and survives edits and cloning. Existing dashboards retain the three-day default. The shared filter bar can override it for the current view.

## Semantic configuration

`DashboardInput` is a versioned configuration, not embedded data. Widgets declare a semantic query, a visualization (`metric`, `bar`, `table`, `stacked`, or `line`), width (1–3), title, and optional plotted series. The builder discovers available models and members through `/api/metrics/meta`. Saving validates every query against that catalog.

The shared filter bar translates the same syntax used by the traces page into native semantic conditions. For example, `attributes.env = prod` becomes `{ member: "logs.parent.attributes", path: ["env"], operator: "equals", values: ["prod"] }`. Registered parent-trace fields, operators, values, and JSON paths are validated; values and path segments are SQL parameters. Missing JSON keys remain distinct from explicit null, and Boolean values remain distinct from numbers. Nested semantic AND/OR conditions are supported. Relative dates resolve once against the dashboard refresh time. Text containment uses PostgreSQL lower-case text comparison in both the traces page and dashboard.

The shared filter bar starts with `startedAt >= -3d`, matching the traces page. Its `startedAt` clauses override saved windows when rendering; there is no separate date dropdown. Relative and explicit date bounds are supported. Clearing date clauses uses the maximum supported 90-day window; wider or contradictory ranges show an error. Windows are half-open: `from <= startedAt < to`. Span counts, usage, cost, and TTFT use **span start time**, including spans whose parent trace started before the window. Latency uses **terminal trace start time** and its persisted end-minus-start duration. Parent trace filters apply through the trace relationship, independently of span time eligibility. Daily buckets use the requested IANA timezone, including DST boundaries, and sort chronologically by default.

## Cost and aggregation

The widget editor offers five **Data sources**, with record descriptions independent of API identifiers:

| Source | One record | Main metrics | Main dimensions |
| --- | --- | --- | --- |
| Traces (`traces`) | One request, selected by start | Lifecycle counts/rate, terminal request duration, unique users/sessions, eligible child LLM cost/tokens and quote coverage | Trace/name, operation, status, user/session, participating agent/workflow/version, workload model set |
| Spans (`spans`) | One step, selected by start | Lifecycle/kind counts, actual terminal span duration, LLM cost/tokens, TTFT samples, quote coverage | Span/name/kind/status, model/provider, parent trace/user/session, nearest agent/workflow/version, function/step, recorded execution role |
| Evaluation Runs (`evalRuns`) | One evaluation batch, selected by creation | Lifecycle counts, elapsed batch duration, selected/executed/completed cases, scorer executions, exact case coverage | Run/name/status/dataset; saved agent/workflow/model membership filters |
| Evaluation Results (`evalResults`) | One scorer execution against a case | Result/scored/error counts, normalized score, explicit pass/fail rate, evaluated cases/traces, attribution coverage | Run/case/dataset, scorer/version, result status, saved operation/version and evaluated workload model |
| Scores (`scoreValues`) | One current saved rating | Counts by type/origin, compatible numeric mean/min/max, boolean counts/rate, category distributions | Score definition/name/type/scale/origin, author type/reviewer, target kind/ID and optional producer links |

Traces and Spans support related scorer, scorer version, dataset and case filters through the parent request. Metadata filters keep their scopes explicit: span, parent trace, run, result, saved case and rating metadata. Typed JSON paths preserve numbers, strings, booleans and missing values.

Run completion counts a selected target once only after every frozen scorer/version has a terminal result; technical errors are terminal, not successful quality checks. Runs with insufficient historical linkage are excluded from coverage and identified by the coverage-eligible run count. A denominator of zero returns null.

Evaluation Results starts from all executions and uses saved case attribution. Unattributed historical results stay in totals and missing-context buckets. Multiple workload models form one **Multiple models** bucket; grouping by participating operations can overlap. The scorer-version picker supports meaningful comparisons. Workload model is never the judge model.

Scores unions native, imported and review ratings with origin-qualified identities. Raw numeric values retain their original scales. Numeric aggregates require compatible definitions; cross-definition queries fail unless grouped by Score definition. The editor requires a definition selection or grouping before enabling these metrics. Imports can explicitly declare `definition: { id, version, min?, max? }`; producer identity and this declaration form compatibility identity. Imports without a declaration have individual unknown scales. Review author type preserves human/API/MCP provenance. Review edits replace the current rating and its time, not an invented event history. Multi-select categories count once globally and once per selected category.

All five sources support timezone-aware day, Monday-based week and month buckets. PostgreSQL owns aggregation, sorting, HAVING and pagination. Metric metadata includes record identity, event time and denominator where applicable; dimension metadata declares grouping/filter capabilities and overlap. Source metadata also lists context unavailable without additional instrumentation.

The catalog still resolves `logs`, `scores`, `evalQuality`, `agents` and `workflows` for existing dashboards and performance pages. Legacy widgets remain editable and expose an explicit **Preview source migration** action showing before/after queries and population changes. Applying it is opt-in. Mixed request-latency/span-usage widgets must be split manually. New templates use the five primary sources. Agents/workflows remain contextual dimensions and their own performance views.

While arranging widgets, the canvas reserves one viewport of scrollable space below the grid. This space disappears in read-only and narrow stacked previews. Time-chart tooltips show only recorded values for the selected bucket, sorted highest first, including measured zero. Grouped legends omit series with no recorded values and rank the rest by their period summary. Missing observations remain gaps in the chart.

`spans.costUsd` sums finite, nonnegative cost quotes from LLM spans whose cost status is neither missing nor partial. The total card and ranking use that same measure; ranking adds `spans.trace` grouping and `spans.hasCost = yes`. Names plus unique IDs keep repeated operation names separate. Across the full ranking, costs reconcile with the total under the same filters and window. A paginated top-ten view is only a subset of that total.

Cost breakdowns use the same eligibility rule and stored components. No quotes are repriced, wrapper costs are not added, and missing values remain null. Estimates remain estimates; these are not invoiced amounts. Token normalization handles the existing ingestion aliases, subtracts cached input from uncached input, and avoids adding reasoning tokens twice. TTFT requires explicit instrumentation and is not inferred from total duration.

TTFT accepts finite, nonnegative numeric span attributes in this order: `ttft.ms`, `latency.ttft_ms`, `gen_ai.latency.time_to_first_token` (seconds, converted to milliseconds), `ai.response.msToFirstChunk`, and the older `ai.stream.msToFirstChunk`. All other fields use milliseconds. AI SDK streaming calls record first-chunk timing; non-streaming `generateText`/`generateObject` calls do not provide it. Only LLM spans contribute to TTFT aggregates, and absent measurements remain null. TTFT-only charts show **No first-token timing recorded** when no samples are available. Migration `0010_ai_sdk_ttft.sql` rewrites the stored timing column on traces and spans once, recovering previously recorded AI SDK timing without changing raw attributes. Dashboard queries continue to aggregate the stored column in PostgreSQL.

To rank repeated trace names together, group `spans.costUsd` by `spans.traceName` and order by cost descending. Add `{ "member": "spans.spanCostUsd", "operator": "gt", "values": [0] }` to hide zero-cost groups. This filter selects positive eligible LLM span quotes before aggregation, so every returned group has positive cost. Names are grouped exactly, including case; different trace IDs with the same name share one row. The existing `spans.trace` grouping still ranks individual traces. Use Traces for request duration and Spans for span duration; their start-time populations differ.

Use `spans.spanName` to rank raw span names across traces. Shared SDK names such as `ai.generateObject.doGenerate` combine unrelated application functions; use **LLM call name** (`spans.functionName`) for their recorded application identity. Calls with the same resolved name are aggregated across runs. The grouping picker and optional chart labels use the shared circular chat-bubble LLM icon. Filtering, grouping, sorting, and pagination execute in PostgreSQL; related parent context is joined without multiplying span facts.

`spans.functionName` uses the nearest recorded `ai.telemetry.functionId` or legacy `ai.functionId`, named function, or explicit agent. Generated AI SDK function wrappers are skipped. `spans.agentName` and `spans.workflowName` use the nearest explicit matching membership, falling back to a trace membership; `spans.stepName` uses the nearest task span. Ancestry stays within the same project and trace, can start before the selected window, and stops at cycles. Missing context remains **Unattributed**. Each eligible LLM span contributes to exactly one bucket per dimension, so these rankings reconcile with total known cost. This differs from inclusive agent/workflow performance totals, where nested groups can overlap. Whole-request latency remains in Traces.

Choose the attribution dimension in the widget editor's **Group by** control and narrow it with the existing filters. Saved queries own grouping, ordering and measures. Chart bodies keep their existing layout and legends; they do not add exploration controls, coverage notices or extra result columns. **Show group icons** is an optional chart setting for grouped bars, donuts and tables, disabled by default. Enabling it adds the corresponding icon to the existing category labels.

`spans.pricedLlmCount`, `spans.unpricedLlmCount`, `spans.costCoverage`, and `spans.meanLlmCostUsd` remain available as explicitly selected measures. Cost coverage is the share of LLM calls with complete quotes, including zero-cost quotes. Average cost includes only priced calls. These measures are never automatically added to saved queries or chart results.

All registered models filter, aggregate, order and page in PostgreSQL. The raw-fact ceiling is removed; window and result-page limits remain. Identical batch queries share execution on one pinned read-only snapshot. See [bounded data reads](bounded-data-reads.md) for the forward contract and outstanding capacity qualification.

## Snapshot consistency

The renderer submits chart queries, summaries, and metric tile comparisons through `POST /api/metrics/batch`: `{ queries: [...] }`, bounded to 1–40 queries per request. A widget's current period, previous period, and version cohorts always stay in the same batch. The service validates queries and executes them sequentially on one pinned, read-only database transaction. Each result in a batch carries the same snapshot `asOf` and request identity. Chart summaries are aggregate queries, not averages of daily averages or percentiles. Refresh and pagination replace the complete result set together. Single-query consumers may still use `/api/metrics/query`.

## Metric tile comparisons

To track one score, choose **Scores → Metric tile**, then search **Score definition** by scorer name (for example, “Brand extraction: accuracy”). Options show the scorer version, value type, and scale. Selecting a numeric definition on a count tile switches its measure to **Average numeric value**; you can still select a count or another measure explicitly. Set the dashboard range to **Last 7 days** to compare that score's average with the preceding seven days. Both periods use the same definition and scorer version, and values stay on their recorded scale. Choose **Higher is better** for accuracy. Returning to **All definitions (counts only)** switches numeric aggregates back to counts so unrelated scales are never combined.

Every metric tile compares the selected range `[from, to)` with the immediately preceding range `[from - (to - from), from)`. The windows have the same elapsed duration, including across daylight-saving changes. Measures, filters, timezone, and version selections stay identical. Cards have no border; metric tiles show their value and delta without repeating the metric title underneath. Hovering or focusing the delta shows the previous value, metric details, and exact comparison dates in a tooltip.

Below the aggregate, a compact line with a subtle area fill runs across the card from oldest to newest day, without axes or labels. Hover a point or focus the chart and use arrow keys to see its date and formatted value. The history uses the same range, timezone and cohort as the total; daily averages, rates and percentiles are computed independently of the whole-period aggregate. Whole-period measure thresholds do not filter individual days. Zero counts remain zero, missing values leave gaps in the line, and an absent aggregate hides the chart. Current totals, previous totals, daily values and version cohorts stay in the same database snapshot; scalar pagination does not truncate the daily series.

Counts, cost, and duration show relative percentage change. Rate metrics show percentage-point change (20% to 12% is −8 pp). When the previous value is zero, the tile shows the absolute change instead of an undefined percentage. Equal values are neutral; missing values show “No current data” or “No previous data” and are never substituted with zero.

Improvements are green, regressions red, and arrows indicate the direction of the change. Failures, error rates, latency, and cost default to lower-is-better; completed traces and explicit scoring pass metrics default to higher-is-better. Volume and arbitrary scores default to neutral. The metric editor's **Improvement direction** control can override this with higher-is-better, lower-is-better, or neutral; **Automatic** restores the metric default. The optional widget `trendDirection` setting persists with the dashboard, so existing dashboards gain automatic comparisons without migration.

## Persistence and upgrades

The initial migration `migrations/0001_initial.sql` stores dashboard configurations. The CRUD endpoints are `/api/dashboards` and `/api/dashboards/:id`; updates/deletes use revision checks to reject stale writes.

The persistence boundary upgrades old dashboard configurations when reading or saving: legacy `.filter` expressions become native conditions, and the old `traces.reportedCostUsd` bar ranking becomes `logs.costUsd` grouped by `logs.trace`. Reads return the upgraded configuration; the next save persists it. The old trace-level measure remains available to independent API consumers with its original stored-trace-cost meaning. Chart components contain no legacy-query adapters.

## Chart visual standard

Use shadcn Base UI chart primitives with Recharts and the shared `dashboard-chart-style.ts` palette, bars sized to their category bands, subtle grids, and consistent spacing. Bar charts reserve 20% of the band on each side instead of capping thickness at a fixed pixel size. Semantic result keys map to flat chart keys so dotted names are not interpreted as object paths. Formatting comes from semantic annotations. Keep pagination hidden when all results fit. Quality metadata stays in the API; widgets omit quality alerts and date legends. Loading, errors, and empty states remain visible.

The **Group by** combobox accepts multiple fields for bars, donuts, and tables. Each distinct tuple becomes a category or row; bar labels and donut legends/tooltips include every selected field. Select, for example, Workflow / agent + Evaluated model + Scorer version. Grouping uses the semantic query's existing `dimensions` array and server-side aggregation, with the same row limits and pagination. Metric tiles remain ungrouped. Line and stacked charts require a single time grouping and support one optional **Series by** dimension. Choose **LLM model** with **Total LLM cost** to compare daily spend per model; the Cost and usage template includes this chart. Model identity follows the recorded response model, then request model and SDK model aliases, without repricing. Missing models display **Not recorded**. Each series has its own whole-period aggregate, and missing cost observations remain gaps. Grouped time charts request up to 5,000 time/group rows and show a partial-data notice if the result is truncated; narrow the date range or filters in that case.

The legacy `evalQuality.groupModel` shortcut remains readable by saved dashboards and API clients. Opening a widget in the editor expands it into `evalQuality.groupName` and `evalQuality.model`; the next edit saves those separate fields. New evaluation-quality templates use the separate fields. No database migration or backfill is needed.

Donut charts use one measure, with matching slice, tooltip and legend colors. Count and sum measures show the displayed total in the center. Paginated results label it as a shown total and identify shares as page-local. Missing values stay missing, zeros have no arc, and negative values prompt a switch to bars. The weekly health preset uses a donut for error types.

Line charts and metric histories use muted dashed guides across missing values. Internal gaps connect the nearest recorded values; leading and trailing gaps extend the nearest value horizontally. These guides have no area fill or data dots and never enter aggregates. Tooltips omit unrecorded observations. A series with no recorded values has no guide.

## Verification

`tests/dashboard-semantic-consistency.test.ts` covers cost reconciliation, older parent traces, half-open and sub-millisecond boundaries, JSON path/type safety, real concurrent ingestion between batch queries, 20,100-span aggregation, p95, 90-day queries, DST, and configuration upgrades. `tests/dashboard-logs.test.ts` covers filtered counts, usage, costs, latency, and missing TTFT. `tests/dashboards.test.ts` covers persistence, validation, saved queries, and revision conflicts.

## Source rollout and qualification

Migration `0040_score_analytics_instants.sql` adds indexed rating event instants and backfills them once. Apply normal application migrations before using Scores. It does not alter stored dashboard configurations or rating values. The dashboard cache key includes the five-source contract version. API, CLI and MCP consumers receive the same registered catalog; existing query identifiers retain their meanings.

`tests/dashboard-sources.test.ts` checks record populations, missing/zero costs, recovered errors, run/scorer coverage, historical missing attribution, heterogeneous ratings, categorical overlap, current review edits, timezone grains and explicit migration previews. `tests/dashboard-sources-scale.test.ts` checks independent raw SQL oracles, tenant isolation, pagination and EXPLAIN on 20,000 spans and 5,000 results/ratings; its query plans are written to `/tmp/datool-five-source-query-plans.json` during the local test. This is synthetic qualification, not a production capacity claim.

Saved user/session/provider attribution, measured scorer cost/duration/model and review edit history are not fabricated where evidence is absent. Their availability is explicit in source metadata. Existing imported ratings without a stable producer definition require separate groups; a shared display name cannot establish a compatible scale.

See [dashboard performance](dashboard-performance.md) for the repeatable benchmark, measured latency at 20,000/200,000 spans, concurrent refresh rejections, and a transaction-local JIT comparison. Correct query results do not imply that concurrent dashboard latency is acceptable.
