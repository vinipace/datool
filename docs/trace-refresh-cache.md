# Trace refresh caching

The trace list and overview use a project change token to avoid re-reading unchanged data. A short shared response cache reduces repeated queries from viewers requesting the same URL. Polling intervals, pagination and authorization remain in place.

## Correctness and scope

- Migration `0044_trace_read_revisions.sql` records at most 64 UUID revision rows per project, partitioned by trace identity to avoid one shared write lock. Their ordered hash is the single project version cached in Redis. Statement triggers on `traces` and `spans` change it within the write transaction, including imports, updates, late spans and deletion. Rollbacks do not publish changes. Batched statements update each affected project/bucket once, in a stable lock order. Writes in the same bucket still serialize.
- Redis caches the committed revision for at most one second. This deliberately retains occasional small PostgreSQL lookups for active projects rather than relying on a potentially lost after-commit Redis write. No new worker or outbox is required.
- Dataset-item trace lists use the short content-based shared cache because their membership can change through evaluation targets without trace writes.
- The list and overview use weak ETags scoped to the project, complete query, revision and a 30-second time window. The time window ensures relative date filters advance even without writes. Expiry can make a quiet poll fetch again.
- Polling response entries above 512 KiB (serialized envelope included) are returned in full but not stored in Redis. This limits large-payload amplification. Aggregate project/global budgets additionally govern admission (see below).
- Identical list, overview and score requests share responses for at most two seconds, measured from the start of the data load. A shared response retains the validator from its own load, never a newer revision. Scores use only this short cache because they also depend on evaluations, reviews and reviewer metadata.
- Authorization and billing checks run before every cache read and every 304. The HTTP response remains `Cache-Control: no-store`; validators are managed explicitly by the client, not a public CDN.
- The browser retains at most 32 response bodies / 8 MiB, no single body above 2 MiB, for at most 60 seconds. Keys include organization, project and URL. Failed authorization never serves retained data.
- Explicit list refreshes (including totals) bypass caching. Successful first-party API mutations clear browser validators and force fresh reads for three seconds. `X-Datool-Refresh: force` bypasses both server caches.
- Missing migration or unavailable Redis falls back to ordinary reads. Redis is not the durable change record. If its connection fails during a read, the generic cache loader also falls back to PostgreSQL.
- Request counts and authorization cost do not decrease. A continuously changing project with one viewer may gain nothing and pays some cache overhead. One project revision is intentionally coarse: an unrelated trace update invalidates the open overview too.

Committed writes can remain unseen for the cache windows plus the existing polling delay. Relative time filters can remain unchanged for up to 30 seconds plus polling and the response cache window. This is bounded freshness, not a streaming change feed.

## Configuration and comparison

`DATOOL_TRACE_READ_CACHE` accepts `off`, `version`, `shared`, or `combined` (default). `off` disables read caching but does not remove the revision triggers; the harness measures their write overhead separately.

Run against explicitly disposable loopback PostgreSQL and Redis endpoints:

```sh
DATOOL_TEST_DATABASE_URL="$DISPOSABLE_POSTGRES_URL" \
DATOOL_TEST_REDIS_URL="$DISPOSABLE_REDIS_URL" \
bun --no-env-file scripts/compare-trace-refresh.ts
```

The harness creates and drops its own database schema, seeds synthetic traces/spans, creates a temporary organization API key, and sends real HTTP requests to the actual authenticated route handlers through the existing integration HTTP adapter. It compares quiet projects, a continuously updated project with one viewer, and continuous updates with multiple viewers. The writer updates an existing trace four times per second. It keeps a three-second poll interval, spreads viewers across one second, and compares all four modes. It verifies committed changes become visible, authorization still applies, explicit refresh bypasses caching, and reads survive a disconnected Redis client.

`scripts/compare-trace-revision-writes.ts` separately measures 1, 4 and 12 concurrent producers updating independent traces in one project, alternating only the revision trigger. `scripts/verify-trace-refresh-browser.ts` verifies the actual browser API client against the real route handlers, including 304 reuse, immediate post-mutation reads and 401 rejection. Both use disposable schemas.

Reports in ignored `artifacts/trace-refresh/` contain request counts, response-body bytes, SQL statement counts, trace-query counts, revision lookups, latency percentiles and alternating write-overhead measurements. SQL counts include authorization and transaction setup; trace-query counts count SELECT/WITH statements touching traces, spans or score tables. Writer statements are measured separately. This is a local route/database comparison, not a production capacity test; it excludes Next's runtime, TLS and WAN latency.

Optional bounded settings: `COMPARE_ROUNDS` (2–30, default 6), `COMPARE_VIEWERS` (2–50, default 12), `COMPARE_TRACES` (100–100000, default 10000).

## Sessions and evaluations

Session list/detail and evaluation list/detail/group/comparison GET routes additionally opt into `shared-read-cache.ts`. These project-wide responses share the same authenticated API wrapper and Redis primitive, with a separate cache namespace and a two-second maximum age. `DATOOL_COLLECTION_READ_CACHE=off` disables this extension independently of the trace experiment; otherwise it is enabled.

The extension hashes the complete response, project and URL when loading a cache entry. A matching browser validator returns 304 after authorization. There are no additional revision tables, triggers or ingestion writes. Because the cache reloads after two seconds, independent evaluation scores, progress, session metadata and moving date filters are covered without maintaining a dependency list. Quiet results can retain the same ETag across reloads. This avoids response bytes, but still performs a data read per unique URL after expiry. Multiple identical readers within the window share that data read in the same process; cold misses on different processes may each read once.

The existing browser validator limits, force-refresh header, mutation bypass, pagination keys and Redis fallback apply. Authorization and billing are checked even for 304 responses. Other viewers may observe a mutation up to two seconds later, plus their polling delay. Completed evaluation polling still stops as before. Session details still fetch their child trace endpoints; this extension does not introduce a session revision that skips that fan-out, and does not reduce HTTP request counts.

Run the additional checks against disposable loopback services:

```sh
DATOOL_TEST_DATABASE_URL="$DISPOSABLE_POSTGRES_URL" \
DATOOL_TEST_REDIS_URL="$DISPOSABLE_REDIS_URL" \
bun --no-env-file scripts/verify-collection-refresh.ts

DATOOL_TEST_DATABASE_URL="$DISPOSABLE_POSTGRES_URL" \
DATOOL_TEST_REDIS_URL="$DISPOSABLE_REDIS_URL" \
bun --no-env-file scripts/compare-collection-refresh.ts
```

The verification exercises all six routes over HTTP, real Chromium with the bundled browser API client, pagination, score-only updates, run completion/deletion, session renaming, forced reads, project denial, missing authorization and Redis unavailability. It leaves `artifacts/trace-refresh/collection-verification.json`.

The comparison uses 100 sessions, 2,000 traces, 10,000 spans, 50 evaluation runs, 10,000 targets and 5,000 results. It reproduces a 20-trace session's requests every five seconds and a three-page evaluation comparison every three seconds. Each virtual client uses the actual bounded browser validator store. Modes distinguish uncached reads, the trace experiment alone, and the extended cache. It measures quiet projects, active projects with one viewer and active projects with multiple viewers. Counts include authorization and database transaction overhead. The harness records overload errors rather than changing server admission limits; compare latency and query reductions only between error-free runs. It uses a fixed poll cadence rather than reproducing the hook's error backoff. Default `COMPARE_VIEWERS` is four; use twelve for a separate overload probe. `COMPARE_ROUNDS` defaults to six, and `COMPARE_PAGE` can select `session-detail` or `evaluation-comparison`. `COMPARE_SCENARIO` optionally selects `quiet-many`, `active-one` or `active-many`.

## Multi-process resilience and Redis cost

`scripts/verify-cache-resilience.ts` launches three independent app processes against one disposable PostgreSQL schema and Redis instance. It exercises cross-process conditional responses, writes during a Redis stop/start, recovery, rollback, pagination across processes, a slow loader outliving the cache window, and an app crash while holding a cache lease. The restart target is restricted to the explicitly named local `datool-cache-resilience-redis` test container and its loopback port is checked before use. Never point the harness at an operator Redis service.

```sh
DATOOL_TEST_DATABASE_URL="$DISPOSABLE_POSTGRES_URL" \
DATOOL_TEST_REDIS_URL="redis://127.0.0.1:19447" \
DATOOL_TEST_REDIS_CONTAINER="datool-cache-resilience-redis" \
bun --no-env-file scripts/verify-cache-resilience.ts
```

The harness measures actual key allocations with `MEMORY USAGE`, whole-server memory with `INFO memory`, and command counts with `INFO commandstats`. The selected command totals include Redis commands executed inside cache Lua scripts, and exclude measurement commands. It compares caching off/on for shared pages and distinct filters, then verifies oversized trace responses remain complete without being stored. Results are written only to ignored `artifacts/trace-refresh/resilience-*.json`.

The revision is one small, expiring entry per active project, but response keys depend on project, endpoint, pagination and filters. Redis use scales with distinct pages requested during the two-second cache window, not retained historical trace count. The 512 KiB limit applies per serialized polling response. The budgets below cap aggregate admission across projects and processes. Dashboards retain their existing independent cache policy. A crashed loader can leave a small lease key for up to 120 seconds, while other processes continue reading the database. Expired key allocations disappear, but Redis allocator RSS and client buffers need not immediately return to their pre-test values.

These tests verify recovery and eventual convergence under the exercised failures. They do not promise one atomic snapshot across independently polled panels, zero temporary staleness, or capacity at every production traffic level.


## Aggregate polling-cache budgets

Polling revisions, response bodies and in-flight cache leases share one atomic Redis admission ledger. Defaults are **4 MiB per project** and **64 MiB globally**, configurable with `DATOOL_POLLING_CACHE_PROJECT_BYTES` and `DATOOL_POLLING_CACHE_GLOBAL_BYTES`. A missing setting uses the default; zero or invalid values disable new admission. Use the same settings across every app process. These are initial application defaults, not a certification of available production memory.

Each item reserves at least 4 KiB, bounding the number of small entries and leases as well as data bytes. Response reservations include the serialized envelope, a 25% allocation allowance, key bytes and 1 KiB for bookkeeping. These are accounting budgets, not exact `MEMORY USAGE`/RSS limits: allocator fragmentation, connection buffers, other caches and queues require additional headroom. Redis must retain `noeviction` for BullMQ; this feature does not change server configuration or remove queue keys.

Admission, replacement and lease release are atomic Lua operations. ioredis caches the script with `EVALSHA` and reloads it after Redis restarts. Both budgets must allow the new reservation before Redis stores a key. Full results still return from PostgreSQL when a budget is exhausted; requests never wait for capacity or extend cached freshness. Cache hits need no additional accounting requests. Tiny revision keys use the same project/global budget as responses; a rejected revision write still permits validation against the revision just read from PostgreSQL.

Expiration accounting uses Redis server time. Every operation reclaims at most 64 expired reservations, so high cardinality cannot cause an unbounded cleanup scan. A backlog can conservatively reject admission until subsequent operations reclaim space. Metadata expires one second after the latest reservation when traffic stops. A crashed app can reserve a 4 KiB lease for up to 120 seconds, after which it is reclaimed. Replacing a cached value charges only its current size; failed or externally deleted keys can temporarily overcount capacity, preserving the limit.

Version 2 polling namespaces prevent reuse of unbudgeted entries from older code. A rolling deployment can temporarily include the old processes' independent caches; the full aggregate guarantee applies once all app processes run this version with identical budgets. The ledger targets the application's standalone Redis deployment and must remain alongside its keys; do not independently delete bookkeeping or enable key eviction. Old response keys expire within two seconds; orphaned old leases can remain for up to 120 seconds. Redis loss/restart follows the existing database fallback path.

`tests/polling-cache-budget.test.ts` runs in CI against real Redis and verifies concurrent admission, per-project fairness, global exhaustion, full response fallback, byte limits, replacements, expiry, crashed leases and queue isolation. The multi-process harness also saturates small budgets across three independent processes, checks an authenticated HTTP response remains complete, and verifies caching resumes after expiry.
