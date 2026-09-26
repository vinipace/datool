# Route stale-while-revalidate

`src/server/cache/stale-while-revalidate.ts` provides a reusable JSON data cache;
`src/server/cache/redis.ts` supplies Redis storage through `REDIS_URL`.
Authorize the request **before** reading the cache. Include the authorized tenant
and every input that changes the returned data in the key. Cache successful data,
not Response objects, credentials, request headers, or errors.

```ts
import { after } from "next/server"
import { routeSwrCache } from "@/src/server/cache/redis"

// Inside an already-authorized route:
const result = await routeSwrCache()({
  namespace: "my-resource-v1", // Bump when result semantics change.
  scope: authorizedProjectId,
  key: { query, timezone },
  freshMs: 60_000,
  maxAgeMs: 15 * 60_000, // Total age, including the fresh minute.
  load: () => readAuthorizedData(),
  defer: after,
  force: false,
})
// result.data is the payload; result.state is fresh, stale, miss, or bypass.
```

## Behavior

- Fresh entries return immediately without starting work.
- Stale entries return immediately and schedule revalidation with Next's `after`.
  A Redis lease deduplicates background work across processes. In-process reads
  also share an in-flight computation. Cold reads in separate processes may
  compute concurrently; only a lease owner can publish.
- At `maxAgeMs`, the value is unusable, even if Redis still holds it. The request
  waits for a successful read; failures surface instead of serving expired data.
- Failed background work leaves the original age unchanged. It can retry on a
  later stale request. Expired leases allow recovery after a process stops.
- Redis outages fail open to ordinary reads; they do not take down the route.
  Redis commands have a 500ms timeout. Missing `REDIS_URL` bypasses caching.
- Payloads over 10 MiB are not cached. TTL is measured from computation start,
  so computation time cannot extend the allowed age. A superseded lease cannot
  overwrite or unlock its replacement.

Next `after` runs within the route process's supported lifetime. This is a
best-effort read refresh, not a durable job: process termination simply leaves the
old entry eligible for another refresh until hard expiry. No new worker is needed.
Keep read deadlines shorter than the default two-minute lease.

## Dashboard integration

`POST /api/metrics/batch` optionally accepts:

```json
{"queries": [], "cache": {"dateFilter": "startedAt >= -90d", "rangeEnd": 1789550400000, "force": false}}
```

The example omits actual queries; the endpoint still requires 1–40 valid queries.
Requests without the hint retain ordinary uncached behavior. The dashboard sends
hints only when its shared filter contains dates alone. Unsupported or mismatched
hints bypass caching. Every query is validated before cache access.

The key includes project scope, semantic catalog/contract, canonical date clauses,
timezone, full query configuration, pagination, and batch order. Only date windows
proven to match the supplied date selection (including the previous-period
comparison) become stable period markers. Built-in widget filters remain in the
key. Full-text and other user filters make the hint ineligible.

Relative windows are resolved again using server time when computing data.
Cached results retain their real query windows and snapshot timestamps. Charts,
totals, histories, and comparisons in a batch are cached together.

Freshness is 60 seconds and maximum age is 15 minutes. The response includes
`X-Datool-Cache`; HTTP responses remain `Cache-Control: no-store`. Authorization
runs on every hit. The dashboard silently checks up to six times at roughly
five-second intervals after a stale response to adopt background results. It
stops once fresh, on navigation/unmount, or after the check limit. The existing
Refresh action forces a read. There are no new labels, controls, or visual states.
