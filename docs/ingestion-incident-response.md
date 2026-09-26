# Ingestion incident response

Treat an HTTP 202 as queue acceptance. Recovery is complete only after a unique
event has a PostgreSQL receipt and the oldest blocked work is understood.

## Detection

The ingestion worker emits a payload-free `ingestion_health` record every minute.
It reports Redis data/RSS memory, its configured data limit, queue counts, and a
bounded sample of pending work without recent completions. The monitor uses its
own connection with a five-second command timeout.

| Signal | Operator action |
| --- | --- |
| Redis memory at 70% | Investigate retained jobs and growth before the queue fills. |
| Redis memory at 85% | Page the operator; compact redundant diagnostics and inspect capacity. |
| Pending work without progress for two minutes | Page the operator; inspect dependencies and PostgreSQL. |
| Failed events retained | Investigate the first failed predecessor; payloads are deliberately retained. |
| AOF disabled, eviction enabled, or AOF write error | Page the operator; correct durability before declaring recovery. |
| No health heartbeat for five minutes | Page through an external monitor; the worker cannot report its own death. |

These are alerting thresholds, not a guarantee of spare capacity under arbitrary
input volume. Completed entries expire independently of new completions. Failed
payloads still require replay or a separately verified durable archive; they must
not be evicted or deleted to disguise an incident. An ongoing failed-event backlog
can still exhaust memory.

Configure the installation's logging provider to notify a tested operator channel
for critical health records, queue/cleanup errors, and missing health heartbeats.
Keep project IDs, host names, Slack credentials, and actual incident records in the
private operator runbook. A log record without a configured notification channel
does not count as a working alert.

## Diagnose and recover

Run in the existing worker container using the installation's operator access:

```sh
bun run ingestion:jobs health
bun run ingestion:jobs status
bun run ingestion:jobs compact-stacks
bun run ingestion:jobs clean-completed
bun run ingestion:jobs health
```

`health` exits 2 on a critical condition. `compact-stacks` retains the latest stack
of each failed job and returns the number of jobs compacted and bytes removed.
It atomically checks the failed state and observed field so concurrent replay
cannot modify active work. It is tested while Redis rejects allocating writes at
maxmemory. It changes no event payloads, receipts, attempt counters, or job status.
`clean-completed` removes at most 1,000 entries older than 24 hours per invocation;
their PostgreSQL receipts remain authoritative. Repeat only if another batch is
needed. Never run `FLUSHDB`, `FLUSHALL`, queue obliteration, or enable eviction.

Resolve the reported error before retrying a failed job:

For `POSTGRES_22P02`, inspect the PostgreSQL error at the same timestamp without
exporting SQL parameters or customer payloads. Unpaired UTF-16 surrogates can be
accepted by JavaScript JSON but rejected by PostgreSQL JSONB. Ingestion replaces
those invalid characters and NUL with U+FFFD in stored text, while preserving the
original queued payload and receipt digest. Valid Unicode and literal escape
sequences remain unchanged. Deploy this normalization before retrying affected
events; replay retains the original IDs and duplicate-delivery checks.

```sh
bun run ingestion:jobs retry JOB_ID
```

Replay predecessors before dependents. A missing predecessor without a receipt
requires its original event; do not fabricate receipts or bypass ordering. Keep
the queue's original event IDs during replay to preserve idempotence.

The TypeScript SDK from 0.3.1 retains unacknowledged lifecycle events in memory
and resends the same IDs and payloads before sending successors. `forceFlush()`
also retries these events before checking persistence. The buffer holds at most
1,000 events or 32 MiB; further writes fail explicitly until it drains. This is
not a disk outbox: process termination can still lose unacknowledged events.
Older SDK instances can retain a predecessor ID for an event the server never
accepted. After an outage, restart or replace those producer instances to start
a fresh chain for new work. This does not recover their historical missing events.

When increasing capacity, update both Redis `maxmemory` and the container limit,
leaving room for allocator/RSS, persistence buffers, and fork overhead. Persist
the host-owned configuration through the installation's supported mechanism.
Verify live limits and the restart configuration separately. A successful
`CONFIG SET` does not prove the setting survives a restart.

## Closure and drills

Record deployment SHA, Redis live/persisted limits, remaining failed-job count,
memory before/after recovery, unique canary receipt, and a delivered test alert.
Keep the incident open if any of these remains unverified. Provide narrowly scoped
operator access to the above commands before an outage, instead of improvising
administrator access or handing an agent broad passwordless sudo.

CI exercises real Redis saturation, diagnostic compaction at OOM, stalled progress,
idle completed retention, transient database failure, predecessor ordering and
idempotent replay. Re-run the disposable load harness for worker, database and
Redis interruptions when changing ingestion or deployment behavior. A successful
drill establishes the tested cases, not a universal zero-outage guarantee.
