# Project alerts

Open **Alerts** in the main project sidebar.

| Page | URL | Behavior |
| --- | --- | --- |
| Alerts | `/p/<projectSlug>/alerts` | All project rules in the shared collection table, with filters, Display preferences, refresh, row links and export. |
| New alert | `/p/<projectSlug>/alerts/new` | Configure an empty rule, or use `?template=<id>` to prefill it. Saving opens its notification history. |
| Alert notifications | `/p/<projectSlug>/alerts/<id>` | This alert's paginated notifications, delivery status, attempts, errors and trace links, plus Edit, pause/resume and Delete controls. |
| Edit alert | `/p/<projectSlug>/alerts/<id>/edit` | The same configuration form, prefilled from the saved rule. Save is disabled until something changes and again after reverting it. |

The former `/p/<projectSlug>/settings/alerts` URL redirects to the collection.
Direct links and reloads retain project identity. Filter expressions persist in
the URL. Notification filters run on the server before pagination; Load more
reaches older deliveries, and live refresh pauses while browsing those older pages.
The rule catalog is complete within the existing 100-rule project limit.

The **New alert** button opens a dialog, following dashboard creation. Choose
**Empty alert** or a template, then **Continue** to the configuration page.
Selection does not create a saved alert. The editor contains only configuration
fields; it has no template picker. Template IDs in the URL survive reloads, and
unknown or repeated IDs fall back to the empty form.

The dialog offers six editable templates: **Request failures**, **Error burst**
(10 failed requests in five minutes), **Slow LLM calls** (over five seconds),
**Expensive requests** (recorded cost over $0.50), **Guardrail failures**, and
**Model fallbacks**. The last two require the documented boolean log attributes
`guardrail_failed` and `fallback_used`; they do not infer those events from text.
Templates default to in-app delivery and a five-minute cooldown. **Empty alert**
starts from the original default configuration. All prefilled values are editable.

Owners and admins can create, edit, pause, resume and delete up to 100 rules per
project. Members can read rules and notification history. Every API operation
checks the project's organization membership; cookie mutations require a trusted
origin. Edits use revisions to reject stale saves.

## Rules and filters

- **Log event:** evaluates new and materially updated traces and spans after the
  rule is created. Existing logs are not replayed. Matching events arriving during
  the notify interval are discarded, including events processed after a backlog.
- **Time-window count:** every minute, counts current matching traces and spans
  whose start time falls within the selected window (1 minute–24 hours). Fires at
  or above the threshold; can fire again after the notify interval while the
  threshold remains met. Use `resource = 'trace'` to count only requests.
- **In-app notification:** records a delivered notification in this project's
  history. **Webhook:** sends a JSON POST and records the HTTP delivery result.

The SQL-style filter supports comparisons (`=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`,
`LIKE`, `IS NULL`, `IS NOT NULL`), `AND`, `OR` and parentheses. It is a bounded
predicate language; arbitrary SQL statements, functions and subqueries are not
accepted. Blank filters match all logs. Supported fields:

| Field                                      | Meaning                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `resource`                                 | `trace` or `span`                                                   |
| `id`, `trace_id`, `name`, `status`, `kind` | Log identity and lifecycle fields                                   |
| `duration_ms`, `cost_usd`                  | Stored numerical facts; missing values are null                     |
| `created`                                  | Start time, compared with an ISO date or `now() - interval '1 day'` |
| `span_attributes.<key>`                    | Flat JSON attribute key, including dots                             |

Examples:

```sql
resource = 'trace' AND status = 'errored'
kind = 'llm' AND duration_ms > 5000
span_attributes.gen_ai.request.model = 'gpt-5'
created > now() - interval '1 day' AND cost_usd > 0.1
```

## Runtime and delivery

Apply the additive migrations with `bun run db:migrate` (PostgreSQL 17+).
Before enabling evaluations, provision a **separate reader login**:

1. Set `DATOOL_ALERT_DATABASE_URL` to the same server/database/options as
   `DATABASE_URL`, with a new username and strong password.
2. Run `bun run db:alerts-reader` using an administrator `DATABASE_URL`. The
   administrator must be able to create roles, grant view access and set role
   resource limits, including `temp_file_limit`. Do not give these administration
   privileges to the reader. Managed database operators can apply equivalent
   role/grant/default settings through their administration tools.
3. Supply `DATOOL_ALERT_DATABASE_URL` to every alert/ingestion worker and restart
   them. Keep the credential server-side. No browser or API caller receives it.

The setup command is repeatable for an existing restricted reader, but refuses
an application/admin login. It grants schema usage and SELECT on a scoped
security-barrier view, with no access to trace/span tables, auth tables, queue
writes or schema creation. Every evaluation checks the role privileges and uses
READ ONLY transactions. Missing or unsafe reader credentials **fail closed**;
there is no fallback to the application's writable connection. The rule's error
is visible on the Alerts page. The local Compose migration service provisions a local-only
reader automatically; production provisioning remains an explicit operator step.

The existing
`bun run worker:ingestion` process also starts the alert worker, so the checked-in
Compose and Dokku worker commands run alerts automatically. An installation
without Redis ingestion can run `bun run worker:alerts` instead. Multiple workers
are supported. The page shows whether a worker has sent a heartbeat in 30 seconds.

Database triggers write an event outbox in the trace/span transaction, covering
both synchronous writes and queued ingestion. Failed transactions cannot notify.
Workers lock individual rules and deliveries to serialize evaluations and
cooldowns. Rule edits discard old-revision events. Pausing cancels pending
deliveries and stops new events; an HTTP request already in flight may finish.
Deleting removes the rule, queued work and its history.

Webhook deliveries retry five total attempts, with 5, 10, 20 and 40-second retry
delays. HTTP 2xx is success; connection failures, timeouts and other statuses are
visible in history. The queue survives worker restarts. Delivery is **at least
once**: if a receiver accepts a POST and the worker dies before its database
commit, the POST can repeat. Receivers should deduplicate using the stable
`Idempotency-Key` header (also the JSON `id`). Notifications contain the alert and
project IDs, name, match count, occurrence time and minimal log identity/status;
trace inputs, outputs and attributes are not sent.

Destinations require public HTTPS addresses, with no URL credentials or
fragments. DNS answers are validated and the connection is pinned to an approved
IP; redirects are not followed. Private/loopback/link-local addresses are blocked.
The local acceptance test explicitly enables `DATOOL_ALERT_LOCAL_WEBHOOKS=1` to
allow `http://127.0.0.1`; that option is ignored in production.

## Evaluation safeguards

The accepted filter is an allowlisted predicate AST. Identifiers, JSON keys and
literal values are bound parameters; statements, subqueries, arbitrary functions,
comments, casts and user-supplied table names cannot reach PostgreSQL. Filters are
limited to 2,000 characters, 180 tokens and 12 levels of nesting. Date literals
must be valid ISO dates/timestamps; invalid LIKE escapes and null bytes are rejected.

| Budget                   | Limit and behavior                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management requests      | 30 mutations per project per fixed calendar minute, including invalid authorized edits; excess returns HTTP 429 and Retry-After. Reads remain available.                                                                                                                            |
| Evaluation attempts      | 120 per project per fixed calendar minute, shared in PostgreSQL across workers; excess waits for the next minute.                                                                                                                                                                   |
| Concurrent reads         | Two globally per database/schema, one per project, enforced with transaction advisory locks; no unbounded waiting queue. Each process has a separate two-connection reader pool.                                                                                                    |
| Query duration           | 1.5 seconds per statement and 2.5 seconds for the whole reader operation, including connection acquisition and multiple queries; connections are destroyed at the total deadline.                                                                                                   |
| Database resources       | 4 MiB work_mem per plan operation and 16 MiB temporary files per reader backend; 250 ms lock timeout. These are PostgreSQL resource controls, not a total process memory cap.                                                                                                       |
| Time-window scan         | At most 20,000 candidate logs before applying the predicate. Counts and the cap check use the same repeatable-read snapshot. Larger windows fail without sending a partial count; shorten the time window.                                                                          |
| Log-event batch          | At most 100 events and 2 MiB of stored JSON payloads per evaluation. An oversized single event fails visibly.                                                                                                                                                                       |
| Repeated expensive rules | Three consecutive time, row, payload or temporary-file budget failures automatically pause the rule, cancel pending deliveries and clear queued events. Fix/edit and resume to reset the failure counter. New events are monitored after resuming; removed backlog is not replayed. |

Due rules are interleaved across projects. Notification delivery gets its own pass
time budget, so expensive filter evaluations cannot consume its entire turn.
Quotas persist through rule edits/recreation and worker restarts. The outbox
remains durable while a project waits for quota; sustained ingestion above worker
throughput still requires queue monitoring and capacity planning.

The worker supplies project/window scope with transaction-local settings; the
view applies it inside each trace/span branch, and no scope returns no rows.
Filters cannot override those settings. The reader credential is a trusted
server credential able to set scope for different projects; it is **not** a
credential to expose for arbitrary customer SQL or direct database access.
These controls bound this predicate language, rather than providing a general
SQL sandbox.

## Reproduce the proof

Use disposable loopback PostgreSQL 17+ and Redis servers. Integration helpers
isolate a new schema and remove it on completion; they never use `DATABASE_URL`.
Do not point the Redis test variable at a shared application queue.

```sh
bun test tests/alerts-filter.test.ts
DATOOL_TEST_DATABASE_URL=postgresql://... bun test tests/alerts-integration.test.ts tests/alerts-security.test.ts
DATOOL_TEST_DATABASE_URL=postgresql://... DATOOL_TEST_REDIS_URL=redis://... bun run test:alerts:e2e
```

The browser test creates both rule types through the form, reloads to prove
persistence, ingests real events via `/api/ingest`, verifies a real HTTP 503 and
successful retry across a worker restart, checks notification history and the
triggering trace, and checks route navigation/reload, templates, scoped history
pagination, shareable filters, cooldown, pause, deletion, filter validation, dirty
state, mobile layout, loading, missing alerts and error recovery. Presentation-only loading/error
checks inject a delayed/failed read; ingestion and delivery assertions use real
services. It saves screenshots, worker/server logs and `proof.json` under
`artifacts/alerts-e2e/` and cleans up its processes and database schema.

Add `DATOOL_ALERT_E2E_PRODUCTION=1` to also build with `bun run build`
and check sidebar navigation, creation, detail reload and editing under
`next start`. This uses a temporary loopback HTTPS proxy and an OpenSSL-generated
certificate so production authentication checks remain enabled. The certificate
and proxy are removed afterward. Delivery is verified before this navigation-only
phase, which stops the worker and therefore shows the offline notice.

Security acceptance additionally uses an actual restricted login to attempt base
table reads/writes, hostile and randomized predicates, cross-pool concurrency,
query cancellation, quota exhaustion, oversized JSON and a 40,002-row workload.
It saves timings and assertions to `artifacts/alerts-e2e/security-proof.json`.
This is a finite local acceptance workload, not a production throughput guarantee.
