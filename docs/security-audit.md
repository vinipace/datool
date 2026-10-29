# Security audit events

Application access evidence is emitted as a single-line JSON object with
`event=security_audit` and `version=1`. No separate database, queue or network
request is added. Deploy both web and worker from the same release. These events
are separate from customer AI execution traces.

## Coverage and interpretation

| Boundary | Event | Meaning |
| --- | --- | --- |
| Shared project HTTP APIs, including cached reads | `http.METHOD.resource` | Authorized principal/project, response status and result of the request; failed authorization has an unknown principal and omits the untrusted claimed project |
| Shared Build dispatcher (UI/API/CLI/MCP) | Registered `build_*` name | Operation returned or threw, including scope and validation failures |
| Standard MCP tools and review prompt | Registered operation name or `mcp.review_session` | Tool/prompt data access returned or threw |
| Shared MCP HTTP transport, including specialized UI resources | `mcp.tools.call`, `mcp.resources.read`, other recognized methods, `mcp.request_failed` | Transport response status; a successful HTTP envelope can still contain a tool-level error |
| Shopify executor used by web and channel agents | Registered `SHOPIFY_*` name | Invocation returned or threw; connection and conversation correlation IDs when available |
| Successful website history/transcript reads | `visitor.conversations.list`, `visitor.conversation.read` | Verified visitor ID and scoped connection/conversation; tokens and messages are excluded |
| Organization key management | `api_key.create`, `api_key.revoke`, `api_key.creation_enabled/disabled` | Successful change by the authorized account; key ID only |
| Auth plugin member/invitation/key changes | `auth.member.*`, `auth.invitation.*`, `auth.api_key.*` | Auth endpoint result, initiating account when a session exists, returned target ID and recognized new member role |

Events include a UTC timestamp, random event ID, action, outcome and status.
Where known they include organization, project, actor type/ID, client ID, target,
connection and conversation IDs. Wrapped operations include elapsed milliseconds.
An API-key actor is the **key ID**, not its name, secret or creator. A worker's
Shopify invocation is a **system** action, not proof a shopper or human operator
performed it; use its conversation correlation to investigate the authorized
identity/confirmation records separately.

`success` means the boundary returned without an error (or HTTP status below
400). It does not prove recipient delivery or a completed commerce mutation:
a tool may return a cart command, quote, pending operation or idempotent replay.
401/403 are `denied`; other failures are `error`. Raw exceptions, tool arguments,
results, URLs, query filters, request/idempotency keys, cookies, visitor tokens,
credential values and message contents are never passed into this logger.

HTTP, dispatcher and provider events can describe different layers of one user
action. Auth key events may accompany an attributed organization-management
event. Count by boundary, not as unique customer actions. A batch read records
the operation, not a complete inventory of rows returned.

## Collection, access and retention

Use the installation's configured logging service first. For the bundled Google
Cloud collector, see [the logging runbook](../ops/gcp-logging/README.md#find-production-logs).
Application JSON is retained as text in `jsonPayload.message`; a Logs Explorer
filter can use the operator's actual project/node/namespace selectors plus:

```text
logName="projects/PROJECT_ID/logs/datool.container"
jsonPayload.message:"\"event\":\"security_audit\""
```

Narrow by timestamp and a known opaque ID/action. Verify freshness with one
synthetic API read, key/role change and channel action, and check web and worker
sources. Do not paste production records into public issues. Restrict log reading
to operators who need it, separate deletion/retention administration from routine
reading where possible, and record the chosen retention and access reviews in
the private operator runbook. The events still contain linkable identifiers and
must be treated as personal/security information.

Logging is best effort: stdout or collector failures do not turn a completed
action into a failed request and duplicate retries. A process crash can precede
the final event; the collector has bounded buffering and can drop old events.
This is **not** an immutable or lossless audit ledger. Verify collector delivery,
retention, access restrictions, failure/staleness alerts and recovery separately.

## Explicit limits

This change does not audit direct SQL, host/cloud administrator access, every
internal database read, authentication rejections before registered callbacks,
or row-level inventories of specialized MCP UI resources. Public visitor events cover successful
reads, not every rejected token. Existing operational logs are not retrospectively
converted into these events. New data-access surfaces must use an audited shared
boundary or add a narrow event and a regression at that surface.

These limits and the outstanding operational controls prevent claiming complete
protected-customer-data access coverage, a SOC 2 report, or Shopify approval from
this code change alone.

## Verification

Regression checks extend existing real PostgreSQL/HTTP/OAuth fixtures:
`tests/organization-auth.test.ts`, `tests/build-api.test.ts`,
`tests/build-shopify.test.ts`, and the visitor-history case in
`tests/build-channel-durable.test.ts`. They check caller attribution, successful
and denied operations, visitor ownership, metadata-only output, and preserving
results when the log sink throws. Production collector delivery is a separate
post-deployment check.
