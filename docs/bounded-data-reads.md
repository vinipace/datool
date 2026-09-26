# Bounded reads and explicit invocation groups

The forward semantic contract is `datool-semantic-v2`. PostgreSQL filters,
aggregates, sorts and pages all registered sources, including spans, traces, evalRuns, evalResults and scoreValues, plus legacy logs, scores,
agents and workflows. The application receives aggregate pages and scalar
quality diagnostics. There is no 20,000 raw-fact cap or JavaScript aggregation
fallback. The 90-day window and 5,000 aggregate-row page limits still apply.

## Groups

Write `group: {type: "agent" | "workflow", name: string, version?: string | null}`.
Both traces and spans use `group_type`, `group_name`, `group_version`, independently
of the trace operation or span kind. Names and versions are
case-sensitive, nonblank, at most 200 characters. A missing version means
unversioned, not a wildcard. Group identity cannot be patched. Each trace or span
has at most one explicit membership; children do not inherit it. Multiple traces
can share a group while retaining their original operation types. Counts measure
member operations, not distinct workflow executions. Nested operations remain separate spans; their inclusive
costs can overlap and must not be added as a billing total.

The SDK named helpers populate this contract. OTel uses only
`datool.group.type`, `datool.group.name`, `datool.group.version`.
`metadata.agent.name`, attributes, display names, operation and legacy tags do
not classify invocations.
The agent/workflow pages group by name plus version; omitting version from a
semantic query intentionally aggregates all versions. Drilldowns match all
group clauses on the same invocation, including grouped descendants.

A transactionally maintained `trace_group_memberships` table records each explicit
root and child group. Group drilldowns select distinct matching trace IDs, with
name/version indexes, before loading trace payloads. Trace paging uses parsed
instants and a stable ID tie-breaker.

Project/type/time and project/type/name/time partial indexes narrow candidate
invocations before recursive cost traversal. Count/latency queries do not walk
cost trees. Reported inclusive costs also bypass traversal; only invocations
without an inclusive report enter the descendant walk. An index does not make a broad exact percentile or arbitrary JSON
filter constant-time. Retained-volume EXPLAIN and mixed workload measurements
remain necessary before making a capacity claim.

## Snapshots, paging and refresh

A semantic batch executes sequentially on one pinned PostgreSQL REPEATABLE READ,
READ ONLY snapshot. Identical normalized queries execute once within that batch.
`asOf` identifies snapshot acquisition, not a replication watermark. There is no
cross-request result cache. Compatible scalar queries fuse their measures while
preserving individual query metadata and quality. Traces and Logs latency share
the same scalar trace facts within the snapshot. Grouped/top-N queries retain
their own SQL ordering and pages.

Trace/span attributes are native JSONB. Generated columns prepare duration, cost
eligibility/breakdowns, token usage and TTFT at write time. Scalar JSON equality
uses typed containment and GIN indexes; arbitrary ranges and substring searches
are not universally indexed.

`invocation_hourly_stats` maintains additive agent/workflow counts, duration sums
and sample counts in the same transaction as inserts, updates and deletes. Empty
buckets are removed. These summaries are used only for fully covered hour
boundaries and supported name/version/status/source filters. Rolling windows
combine full-hour summaries with raw facts in the two partial edge hours.
Invocation/trace ID filters, cost trees and exact percentiles use raw facts.
Local-day boundaries that split an hour also use raw facts. There is no
summary refresh lag, and p95 is never derived by averaging hourly percentiles.

Sessions, datasets, eval summaries, evaluators and saved views use SQL paging.
Trace span statistics are SQL aggregates for the visible page. Eval summaries
contain counts rather than complete selected-ID arrays. Session traces, dataset
items, trace spans, trace scores and eval targets have bounded child pages.
Comparisons resolve unique dataset-item/trace/input matches across both complete
runs before paging; ambiguous input matches remain unmatched. Opening a compared
row uses that run target's frozen snapshot.

Saved-view selectors, filtering, sorting and projection execute in PostgreSQL.
Unsupported selectors fail. Collection totals are opt-in (`includeTotal: true`). The browser requests them
on initial load and explicit refresh, then retains that count while automatic
head refreshes omit the count query. Narrower trace-list payload projections
remain follow-up implementation work.

Automatic collection refresh only reloads the head while one page is loaded.
Loading history pauses automatic refresh; explicit refresh resets to the head.
Loads abort on resource changes, avoid overlapping work and back off after
failures. Terminal evals stop polling. Cross-mount request coalescing remains
unimplemented. Complete internal evaluation evidence has an explicit 8 MiB
limit and fails instead of returning a truncated artifact.

## Operational limits and deployment

Process admission reserves four active slots for interactive reads and two for
analytics, at most two per project in each lane. Each lane permits sixteen
queued requests, at most eight per project, waiting at most two seconds
(`READ_BUSY`, HTTP 429 when full or expired). The analytics pool has
six connections, separate from the ordinary pool (default ten). Interactive collection and detail reads also use the analytics pool. A semantic
snapshot uses ten-second statement limits and a fifteen-second batch deadline;
interactive collection/detail transactions reduce each statement timeout to
the remaining lifetime, enforce two-second lock waits and fifteen-second idle
protection, and discard the owned connection when the overall deadline expires. Responses above 8 MiB fail with `READ_RESULT_TOO_LARGE`
(413); timeout maps to `READ_TIMEOUT` (504). Configuration catalogs enforce a
500-entry and 8 MiB limit. Limits are per process, not a distributed quota.

Reserve database connections for workers and operations:
`webProcesses * (ordinaryPoolMax + analyticsPoolMax) + workerPools + reserve`
must fit the database budget. A separate pool does not isolate database CPU.
Keep the current single-web-writer deployment until file-backed app/playground
state and eval recovery support multiple writers.

The initial schema uses JSONB for trace/span attributes; `0002` adds explicit
groups and read indexes, `0003` adds generated analytical facts and membership
maintenance, and `0004` adds transactional invocation summaries. For databases
that already recorded the original `0001`, `0003` also converts existing text
attributes to JSONB before adding generated facts. This is a one-way storage
conversion, with no legacy reads or metadata-based group inference. Existing
unclassified history remains unclassified; no historical group or summary
backfill is performed. The migration runner and this transition are tested on
disposable local databases.

`0009` adds independent span `group_type`, copying the authoritative type for
existing explicit memberships while preserving recorded kinds. It switches span
membership and summary triggers and group indexes to that column. Existing
summary identities remain valid. Kinds overwritten by older ingestion cannot be
recovered by this migration.

## Verification status

The repeatable local workload is `scripts/load-reads.ts`; its fixed
2M-trace/2M-span acceptance checker is `scripts/read-load/verify-local-report.mjs`.
Local benchmark and unit/integration success are not evidence of
1,000-user capacity. Registered users, active browsers and request rate must be
measured separately; the broader multi-tenant qualification remains incomplete.
