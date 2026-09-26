# Dashboard source performance

The repeatable benchmark is `scripts/benchmark-dashboard-sources.ts`. It measures the semantic service, PostgreSQL execution, snapshot setup, serialization, and read admission for the five dashboard sources and complete dashboard query plans. It does not include HTTP authentication, network transit, React rendering, or drag interactions.

## Run locally

Set `DATOOL_TEST_DATABASE_URL` to a disposable loopback PostgreSQL database, distinct from the application's `DATABASE_URL`, then run:

```sh
bun --no-env-file run scripts/benchmark-dashboard-sources.ts
```

The harness applies the checked-in migrations and seeds a unique schema. It drops that schema in `finally`, including when a query fails. It neither changes the application database nor makes model calls. `--no-env-file` prevents local application configuration from replacing the explicit test environment.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DATOOL_DASHBOARD_PERF_SCALES` | `1,10` | Dataset multipliers, each between 1 and 25 |
| `DATOOL_DASHBOARD_PERF_REPETITIONS` | `12` | Timed sequential samples after two warmups, between 3 and 100 |
| `DATOOL_DASHBOARD_PERF_REQUESTS` | `16` | Total dashboard refresh requests per concurrency level, between 8 and 100 |
| `DATOOL_DASHBOARD_PERF_CONCURRENCY` | `1,2,4,8` | Closed-loop client counts; an empty string skips concurrency |
| `DATOOL_DASHBOARD_PERF_JIT` | Application snapshot default (off) | Optional `on`/`off`, applied only inside each benchmark read transaction; use `on` to reproduce the original baseline |
| `DATOOL_DASHBOARD_PERF_OUTPUT` | `.tmp/dashboard-source-performance.json` | Raw timing samples, errors, environment, query plans and cleanup status |

## Method

The smaller dataset contains 4,001 traces, 20,000 LLM spans, 1,000 runs, 5,000 results, 5,000 native ratings and 10,000 saved attribution records. The larger dataset has ten times those synthetic facts, plus the fixture's one shared evaluation trace. Spans have 20 model names and 100 workflows; each request has five LLM spans. Cases have one frozen scorer and two saved operation memberships.

Queries cover a 30-day window. Tables are vacuumed and analyzed before measurement. Two warmups precede 12 sequential measurements per workload. Complete dashboards use the application's real query planner, including current/previous periods, daily histories and summary queries. The cost dashboard has 11 widgets; evaluation quality has eight.

At each concurrency level, 16 refreshes run through a closed-loop client pool. Existing admission limits remain enabled: two analytics slots, a two-second queue wait, a ten-second statement timeout and a fifteen-second batch deadline. Rejections are counted separately; successful-request percentiles exclude failed requests. This tests a bounded burst, not sustained arrivals or production user capacity.

Correctness checks verify exact fact counts, complete case coverage, and reconciliation between trace and span costs before timing. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` runs outside the timed samples. Raw samples and full plans are retained in the JSON report. With 12 sequential or 16 concurrent samples, the reported nearest-rank P95 is the maximum observed latency; these are diagnostic measurements, not precise estimates of a production tail.

The synthetic shape does not qualify deep span ancestry, many scorers per case, high-cardinality model names, large imported/review-rating populations, concurrent ingestion, cold-cache disk traffic, multiple application processes, or production hardware. No application result cache is used; database and OS caches are warm.

## Measured results

Measured on 2026-09-22 with PostgreSQL 16.15 (pgvector image), an Apple M4 Pro host with 12 logical CPUs and 24 GiB RAM, and Bun 1.3.14. PostgreSQL used 128 MB shared buffers, 4 MB work memory, and JIT enabled. The database container had no explicit CPU or memory cap and shared the local machine; this is not a controlled production hardware benchmark.

Baseline: **320 timed operations**, including 192 sequential query/dashboard operations and 128 concurrent dashboard refreshes. All sequential operations succeeded. Concurrency produced 28 `READ_BUSY` rejections and no query timeouts. All three fixtures, including the JIT experiment, passed correctness checks and were removed.

All timings below are milliseconds.

| Workload | 20k spans: median | 20k spans: P95 | 200k spans: median | 200k spans: P95 |
| --- | ---: | ---: | ---: | ---: |
| Spans: daily cost by model | 21 | 23 | 63 | 68 |
| Spans: attributed cost ranking | 351 | 397 | 1226 | 1344 |
| Traces: daily child usage and latency | 27 | 28 | 517 | 559 |
| Evaluation Runs: case coverage | 111 | 117 | 1424 | 1614 |
| Evaluation Results: saved workflow/model quality | 77 | 102 | 1111 | 1310 |
| Scores: numeric values by definition | 32 | 70 | 342 | 347 |
| Dashboard: Cost and usage (11 widgets) | 1056 | 1098 | 3027 | 3742 |
| Dashboard: Evaluation quality by model (8 widgets) | 332 | 339 | 3213 | 3437 |

The 11-widget cost dashboard produced 16 SQL statements per refresh; the eight-widget evaluation dashboard produced seven. Result payloads stayed bounded as the fact population grew: the largest response was 137.5 KiB. The benchmark process peaked at 211.2 MiB RSS, excluding PostgreSQL.

### Concurrent cost-dashboard refreshes

| Dataset | Clients | Successful / 16 | Busy rejections | Success P95 (ms) | Successful refreshes/sec |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20,000 spans | 1 | 16 | 0 | 1105 | 0.94 |
| 20,000 spans | 2 | 16 | 0 | 1206 | 1.87 |
| 20,000 spans | 4 | 16 | 0 | 2241 | 1.90 |
| 20,000 spans | 8 | 8 | 8 | 2205 | 1.90 |
| 200,000 spans | 1 | 16 | 0 | 3265 | 0.33 |
| 200,000 spans | 2 | 16 | 0 | 3259 | 0.66 |
| 200,000 spans | 4 | 8 | 8 | 4682 | 0.61 |
| 200,000 spans | 8 | 4 | 12 | 4375 | 0.63 |

With 200,000 spans, each refresh occupied a slot for approximately three seconds. Requests waiting more than two seconds were rejected, as configured. This is observable user-facing backpressure: four/eight simultaneous uncached refreshes are not reliably served by the current two-slot process in this test.

### Query-plan findings

- **JIT compilation:** workflow attribution spent 282 of 368 ms compiling in the smaller fixture. In the larger fixture, case coverage spent 804 of 1,566 ms compiling, and saved result attribution spent 442 of 1,137 ms.
- **Repeated lookups:** at 200,000 spans, workflow attribution touched 813,054 shared buffer blocks; run coverage touched 1,011,362. Indexed lookups remain bounded but accumulate across the fact population.
- **Temporary spill:** larger attribution/results/rating queries wrote 837 / 1,996 / 2,859 temporary blocks respectively with the default 4 MB work memory.
- **Warm-cache qualification:** captured plans reported no shared-block disk reads. These results do not represent cold-start storage latency.

### Transaction-local JIT experiment

The smaller dataset was recreated and measured with JIT disabled only inside each benchmark read transaction. Two warmups and 12 samples per workload were retained; this added 96 timed operations, all successful. Other database/application settings were unchanged. This was a separate run on equivalent generated facts, not a randomized controlled trial.

| Workload | Default JIT median (ms) | JIT off median (ms) | Reduction |
| --- | ---: | ---: | ---: |
| Spans: attributed cost ranking | 351 | 87 | 75% |
| Evaluation Runs: case coverage | 111 | 53 | 52% |
| Dashboard: Cost and usage (11 widgets) | 1056 | 380 | 64% |

The larger fixture was then recreated with JIT off, adding 160 timed operations and eight plans. Its cost-dashboard median fell from 3,027 to 2,322 ms (23%); P95 fell from 3,742 to 2,449 ms. Evaluation-quality median changed from 3,213 to 3,094 ms. This is workload-specific, not a universal speedup. The two-client cost-dashboard P95 was 4,075 ms, worse than the original run, and four/eight-client bursts still produced 8/12 busy responses. JIT alone does not resolve admission pressure.

The application now disables JIT only inside semantic read transactions. A database regression verifies the same pooled connection is read-only/repeatable-read with JIT off inside the snapshot and has JIT restored afterward. No database-wide setting or admission limit was changed.

Raw local benchmark evidence: `.tmp/dashboard-source-performance.json`, `.tmp/dashboard-source-performance-jit-off.json`, and `.tmp/dashboard-source-performance-large-jit-off.json`. Together they contain 576 timed operations and 32 full EXPLAIN plans, plus warmups and cleanup status. Re-run the harness to regenerate these ignored local artifacts.

## Pre-deployment recovery and migration qualification

The semantic error adapter now preserves the one-second `Retry-After` hint instead of falling back to 60 seconds. Only side-effect-free dashboard metric POSTs retry `429 READ_BUSY`: at most five attempts, exponential backoff plus additive jitter, and no new retry after a 15-second retry-start budget. An in-flight query may finish after that budget. Abort signals stop requests and backoff, including navigation/unmount; other errors and dashboard mutations are not retried. Refreshes retain the last chart results; changing the project, filter, or widget query hides incompatible previous results. Browser regressions cover initial recovery, retained charts, and changed-filter isolation.

`scripts/benchmark-score-migration.ts` creates a separate schema with 50,000 native ratings and 50,000 review ratings, applies the analytics migration SQL (now numbered `0040`) in the migration runner's transaction pattern, observes its table lock and offers concurrent writes. With the final migration, the backfill/index transaction took **2,129 ms**. Native/review writes waited **2,134/2,132 ms**; a concurrent trace insert took **12 ms**. All 100,000 historical timestamps matched; subsequent timestamp updates also matched. The fixture was removed.

This migration holds exclusive locks on the rating tables while backfilling/indexing. It now bounds lock acquisition to two seconds and individual statements to 30 seconds. A regression holds a conflicting lock, verifies timeout and complete rollback, then verifies successful application after release. The existing migration-runner regressions also verify upgrading historical data and running the ledger-backed command twice. The local timings do not establish the duration on larger production tables; check production rating counts and long-running transactions before applying this migration. A materially larger backfill should be staged separately.

Run the measurement with a disposable `DATOOL_TEST_DATABASE_URL`:

```sh
bun --no-env-file run scripts/benchmark-score-migration.ts
```

## Production-build HTTP qualification

`scripts/verify-dashboard-release.ts` owns disposable PostgreSQL and Redis containers, seeds 200,000 spans / 40,001 traces / 50,000 cases and ratings, builds the production application, creates a restricted organization API key, and starts the production server plus ingestion worker. No production or configured developer database is used. Containers, schemas and processes are removed in cleanup; credentials are excluded from the report.

```sh
bun --no-env-file run scripts/verify-dashboard-release.ts
```

The run covers a cold 11-widget cost dashboard, eight cached requests, eight coalesced cold requests, forced refresh, and eight distinct uncached filters that retain the full dataset while 30 trace events are ingested. It uses the actual client retry policy, asserts the one-second busy hint, reconciles total cost with SQL, verifies counts for all five sources over HTTP, and verifies both ingestion receipts and persisted traces. All 27 logical metric requests and all 30 writes passed. Twelve busy responses were recovered automatically.

In the final fresh-build run, the cached burst completed in **62–65 ms** per request; the uncached burst with ingestion took **3,951–16,344 ms**, including queueing/retries. Coalesced cold reads took **1,972–1,974 ms**. All 30 ingestion requests were accepted within **70 ms** and persisted, with commits observed while reads were running. These are local diagnostic timings, not production capacity or sustained-load guarantees. The cache and two-slot admission limits were already present; this change fixes recovery while preserving those bounds.

Evidence is under `.tmp/dashboard-release/` (`report.json`, production build, server and worker logs), and `.tmp/dashboard-migration-performance.json`. The release harness can reuse its build with `DATOOL_DASHBOARD_REUSE_BUILD=true` during diagnosis; release verification should use its default fresh build.

Remaining performance work is reducing repeated ancestry/case lookups and temporary spill, followed by realistic sustained/multi-process qualification. No production deployment, production migration, push, or CI run is implied by these local checks.

Production migration preflight remains open. Obtain authorized access using the private operator runbook. Production rating counts and blocking transactions were not queried. Check them, establish a recoverable backup, and run the normal release migrations when deploying the reviewed revision. The local 100,000-row measurement must not be substituted for that check.
