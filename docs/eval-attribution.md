> New dashboards use **Evaluation Results** (`evalResults`), which keeps unattributed historical results and exposes attribution coverage. The `evalQuality` contract documented below remains available to existing consumers with its original attributed-only population. See [dashboard data sources](dashboards.md#cost-and-aggregation).

# Saved evaluation attribution

An eval run can include multiple workflows and agents. New runs save their
explicit memberships in `eval_run_groups`, exposed as `groups` by the shared
eval list/detail API, CLI operations and MCP operations. `groupsResolvedAt`
distinguishes runs using saved attribution from historical runs that have not
been resolved. Historical repair is an explicit operator command; migrations
never backfill history automatically.

The Evals table supports workflow/agent grouping through Display. Grouping
covers the entire filtered history, with exact per-group counts. Groups and
their run lists have separate server cursors; expanding a group loads only its
first page. A mixed run appears in each applicable section, but selecting it
still selects one run. Filters such as
`workflow = "Customer answers" agent = "Support agent"` apply on the server
before pagination. `GET /api/evals/groups?groupBy=workflow`, the
`list_eval_run_groups` MCP operation and `datool evals groups --group-by workflow`
expose the same groups, counts and reusable per-group filters. Membership links open the corresponding resource filter.

Each frozen target also saves its own group/model attribution in its snapshot
and in `eval_target_attributions`. New results use a project/run-scoped
`target_id` foreign key; analytics joins use that indexed column. This prevents a mixed run's results from
being assigned to all of its groups. Connected runs capture attribution when
the application evidence is ready for scoring. Re-scoring copies the saved
attribution; recovery reuses frozen evidence or collects evidence that arrived
late before scoring. Selected-span evaluations include only that subtree.

The `evalQuality` semantic model and **Evaluation quality by model** dashboard
template read these saved facts. They average valid scores in the inclusive
0–1 range and include sample counts and scorer versions. Grouped scores
describe whole evaluated cases involving each group, not independent scores
for each nested operation. Memberships overlap; grouped counts are not additive.
Global counts deduplicate evaluator results across memberships.

Model attribution comes from recorded workload telemetry, excluding scorer
spans and their descendants. Multiple observed models remain in a **Multiple
models** bucket; missing model telemetry remains **Unknown model**. Historical
runs without saved attribution are excluded. Compare the same scorer version
and comparable cases when drawing conclusions about models.

## Query behavior

The normal eval-list path reads indexed saved memberships; it does not fetch
trace evidence per visible row. Chart queries use saved target attribution
and bounded result-time windows. Initial attribution inserts use batches of up
to 1,000 rows; capture checkpoints rewrite attribution only when it changes.
Span resolution indexes parent/child relationships once and propagates model
sets upward. Matching dashboard tiles share three aggregate queries (current,
previous and daily history); the four group charts/tables retain independent
pagination, for seven aggregate queries instead of sixteen.

## Reproducible local measurements

`DATOOL_TEST_DATABASE_URL=... bun run scripts/benchmark-eval-attribution.ts`
creates and removes an isolated schema in a disposable loopback database. It
never reads `DATABASE_URL`. The September 19 local PostgreSQL 17 run used
10,000 runs, 50,000 results and 100,000 attribution rows. Across five warm
samples, median service times were 13 ms for the first 50 runs, 17 ms for a
workflow-filtered page, 57 ms for all workflow group counts, and 1.59 s for the
entire dashboard. All requests included totals; dashboard queries bypassed the
application cache. The target join's actual query plan used both target indexes.
These are local synthetic measurements, not production or concurrent-load guarantees.

The regression test verifies that 1,001 targets with two memberships take four
insert statements and that fused dashboard results, counts, quality annotations
and pagination match individual execution. Existing historical results retain
null `target_id`; the backfill below populates that column together with
attribution. No historical updates run during migration.

## Production backfill

The entry point is `scripts/backfill-eval-attribution.ts`. Deploy the attribution
code and apply migrations **0034 and 0035** first. The script checks that their
columns/tables exist; it never migrates the database itself. Use the production
runtime's `DATABASE_URL` and the **exact project ID**, not a project slug. The
Docker image includes the script and its dependencies.

Choose a fixed UTC cutoff and keep the same project/window for all pages. Start
with a small dry-run batch (the default mode):

```sh
bun run scripts/backfill-eval-attribution.ts \
  --project '<project-id>' \
  --before '2026-09-19T00:00:00Z' \
  --limit 100
```

Review `changed`, `targets`, `resultsLinked` and every `skipped` reason. `targets`
counts targets whose attribution rows would be inserted, not membership rows.
`changed` counts runs, including runs that only need their result links repaired.
The example cutoff excludes September 19; choose the intended cutoff explicitly.
Optionally add `--after '<ISO-date>'` for an inclusive lower bound; `--before`
is exclusive. Limits are 1–1,000 runs per invocation.

Apply the same batch with a **new backup filename in an existing durable directory**:

```sh
bun run scripts/backfill-eval-attribution.ts \
  --project '<project-id>' \
  --before '2026-09-19T00:00:00Z' \
  --limit 100 \
  --apply \
  --backup '/durable/backups/eval-attribution-batch-001.jsonl'
```

For the next batch, use the returned `nextCursor` as `--after-run '<cursor>'` and
a new backup filename. A null cursor means there are no further candidates in
this scan. It does **not** mean skipped runs were repaired. After resolving a
skip, rerun the original window without a cursor; completed repairs are no-ops.
The command returns exit code 2 if any runs were skipped, 1 for a fatal error,
and 130 for an interrupt. On SIGINT/SIGTERM it finishes the current atomic run,
then stops and reports `lastProcessedRun`; resume there or rerun the window.

Each run is all-or-nothing: saved target attribution, missing snapshot attribution,
run memberships, missing result-to-target links and the resolution timestamp
commit together. It preserves scores, result metadata, inputs, outputs, trace
telemetry and existing saved attribution. No app or scorer is invoked. Already
resolved 0034 runs with null 0035 target links are included too.

The repair reads workload models only from frozen snapshots. Missing root/span
group labels may be restored from their exact original IDs because the database
makes those memberships immutable. It never expands the frozen span/linked-trace
scope, infers groups from names, reads current model telemetry, or assigns a
mixed run's entire score population to every group. Missing snapshots, missing
identity sources, incomplete span ancestry, conflicting saved facts and ambiguous
result matches leave the whole run unchanged and appear in `skipped`. A result
without `evalTargetId` is linked only when its trace/dataset-item pair identifies
exactly one target in the same project and run.

Execution uses one database connection, a project-level advisory lock for apply,
per-run row locks, 15-second statement timeouts and a one-second lock timeout.
Running runs, active leases and locked runs are skipped. A run larger than 10,000
targets, 100,000 results or 32 MiB of loaded snapshot/metadata/attribution data is
reported as `run_exceeds_backfill_limit` for separate review. This bounds each
transaction; it is not a promise that every historical run can be reconstructed.

Backup files are created exclusively with mode 0600 and flushed before writes.
They contain sensitive frozen evidence: retain them in private durable storage.
Each `prepared` record includes snapshot before-images, prior run groups/timestamp,
added target identities and exact result links; `committed` records include a
resume cursor. If the process fails after preparation, that record alone does
not prove a commit—check the database or rerun safely. Do not blindly replay a
backup after subsequent evaluations or recovery work; any rollback needs to
check that the recorded after-state is still current.

After apply, rerun the dry-run for the original window, review unresolved runs,
then check grouped Evals and the **Evaluation quality by model** dashboard. The
integration tests cover unchanged dry-run state, real re-scoring from repaired
snapshots, metric counts, selected-span scope, project/cutoff isolation, CLI
execution, conflicting/ambiguous records, concurrency, rollback and safe retries.

## Dashboard operation filters

Operation is the shared display name for an attributed workflow or agent. Dashboard
grouping and table headings use **Operation**, **Operation type** and **Operation
version**. The filter bar uses **Operation name**, **Operation type** and **Operation
version**, while **Workflow** and **Agent** remain specific filters. The existing
`groupName`, `groupType` and `groupVersion` query keys and semantic member IDs stay
unchanged, so saved dashboards and filter URLs remain compatible.

Use the shared dashboard filter bar for workflow and agent criteria. Filters
are optional and persist in the URL alongside date, model and scorer criteria.
The bar accepts `workflow = "Name"`, `agent = "Name"`,
`groupName contains "text"`, `model`, `evaluatorName`, `evaluatorVersion`,
`evaluatorId`, `groupType`, `groupVersion` and `runId`.

The semantic members `evalQuality.workflow` and `evalQuality.agent` filter saved
case memberships before aggregation. Selecting a workflow retains the agent rows
for those cases, excludes other workflow names and never includes unrelated cases
just because they share an eval run. `groupName` filters the chart's own group rows.
