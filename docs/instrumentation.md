# Production trace delivery

Datool stores traces in PostgreSQL (`DATABASE_URL`). Trace exporters now use `POST /api/ingest`, a Redis-backed lifecycle queue. Set `REDIS_URL` on the API and on a continuously running worker, then run `bun run worker:ingestion`. Apply `bun run db:migrate` before starting either process. The worker must run in a persistent process; a request-only/serverless deployment of the web app does not run the worker.

Configure the calling app with `DATOOL_BASE_URL`, `DATOOL_PROJECT_ID`, and `DATOOL_API_KEY`. Use HTTPS outside local development. The API authenticates the project and validates the event before queueing. Redis requires durable storage, AOF persistence (`appendonly yes`, preferably `appendfsync always`), `maxmemory-policy noeviction`, and appropriate access controls. `compose.yaml` includes local PostgreSQL and Redis services with persistent volumes. Managed Redis must provide equivalent durability; a cache configured to evict keys is unsuitable.

HTTP 202 means **queued in Redis**, not yet committed to PostgreSQL. `DatoolSpanProcessor.forceFlush()` waits for the final PostgreSQL receipt (which depends on all preceding writes); await it in the request/shutdown lifecycle. Both the processor flush and manual SDK wait for persistence for up to 60 seconds and report when an accepted event remains pending. Process termination before HTTP acceptance can still lose in-memory events: the application must finish its flush, and Redis/API outages exceeding the bounded client retry window surface an error. This is not an exactly-once network guarantee.

Transient network errors and HTTP 408/429/500/502/503/504 receive eight retries with bounded exponential backoff and jitter, bounded Retry-After, and per-attempt timeouts. Authentication and validation failures are not retried. Each retry reuses the event ID and payload. The worker retries persistence up to 120 attempts, five seconds apart, and retains exhausted jobs for inspection/replay. Events include a predecessor ID so a delayed create cannot be overtaken by a patch. PostgreSQL commits the lifecycle write and receipt together; duplicate/redelivered events return the stored result instead of inserting twice or undoing newer updates. Receipts currently have no automatic retention policy, to preserve replay safety.

Use `bun run ingestion:jobs status` to inspect queue counts and failed job IDs, and `bun run ingestion:jobs retry JOB_ID` after resolving the cause. Replay failed predecessors before their dependents. Monitor failed jobs, oldest waiting/delayed age, worker uptime, Redis disk/memory, and PostgreSQL availability. A dead worker otherwise leaves accepted events queued indefinitely.

The worker also emits a structured health heartbeat every minute. Use
`bun run ingestion:jobs health` for an immediate check and follow the
[incident response runbook](ingestion-incident-response.md) for alert thresholds,
safe memory recovery, and receipt-based verification.

The worker keeps one diagnostic stack per job across retries; failed event payloads
remain available for replay. Completed queue entries expire after 24 hours; the
worker also sweeps up to 1,000 expired completed entries each minute, even when
no new jobs complete. PostgreSQL traces and receipts are not removed by this
queue cleanup. Failed events require investigation and explicit replay; they
are never automatically discarded. Structured ingestion logs include a safe `reason`
code (for example `REDIS_OOM`, `POSTGRES_23503`, or `DEPENDENCY_PENDING`) without
logging payloads, SQL, or connection credentials. `REDIS_OOM` means queue writes
are being rejected: inspect capacity and retained jobs before retrying. Keep
`noeviction`; evicting queue keys can lose accepted events and their dependencies.

`delivery: "direct"` remains available for synchronous local demos and tests; direct writes do not receive automatic retries because they do not use event receipts. The default production SDK path is queued. This is Datool's JSON lifecycle protocol, not an OTLP collector.

## Instrumentation examples

## Codex

Use the [Codex trace connector](./codex-traces.md) for Codex's own runs. It combines a local OTLP/HTTP JSON receiver with saved conversation history, preserving per-request usage and tool results. `bun scripts/codex-traces.ts run -- ...` configures a single Codex execution; `serve` supports a persistent receiver. The connector submits atomic snapshots to `/api/ingest/codex`; a general OTLP exporter still cannot send directly to Datool's JSON APIs.

## AI SDK / OpenTelemetry

`@datool/sdk/otel` exports `DatoolSpanProcessor` for use with an OpenTelemetry `NodeSDK`. See the [Datool AI SDK guide](../content/docs/tracing/ai-sdk.mdx) for setup. The processor sends authenticated lifecycle requests to Datool's JSON API. Install `@datool/sdk` (see [package installation](./npm-packages.md) before the first release). This is Datool's JSON lifecycle API; a general OTLP exporter cannot send to it.

Configure the API key and project as described above. Keep credential files ignored by Git. The client reads the key automatically; `DATOOL_BASE_URL` optionally overrides `http://127.0.0.1:3000` (`DATOOL_TRACE_BASE_URL` remains supported). Start Datool with `bun run dev`.

For an application using AI SDK 7:

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { LegacyOpenTelemetry } from '@ai-sdk/otel'
import { registerTelemetry } from 'ai'
import { DatoolSpanProcessor } from '@datool/sdk/otel'

const datool = new DatoolSpanProcessor()
const sdk = new NodeSDK({ spanProcessors: [datool] })
sdk.start()
registerTelemetry(new LegacyOpenTelemetry())

// generateText({ ..., telemetry: { functionId: 'mock-weather' } })
// Before exit, including error paths:
try { await datool.forceFlush() } finally { await sdk.shutdown() }
```

AI SDK 7 uses the telemetry registration above. Older AI SDK versions use `experimental_telemetry: { isEnabled: true }` as shown in the linked guide. Keep the setup appropriate to the installed version. The adapter retains OTel IDs, parent relationships, timestamps, model/tool inputs and outputs, error events and token attributes. Starts are posted while work runs; `forceFlush()` waits for queued writes and throws if delivery failed.

### Named agents and workflows

Manual tracing uses `tracer.agent()` and `tracer.workflow()` with an explicit `group`. For OTel, set `datool.group.type` (`agent` or `workflow`), `datool.group.name`, and optional `datool.group.version` in the span's initial attributes. Set `datool.trace.root: true` for a trace container. Groups are not inherited by children. Metadata such as `agent.name` does not define grouping.

Membership is independent of operation kind. Any trace or span can join an agent
or workflow group while retaining its captured type and hierarchy. Several step
traces can share a workflow group; its operation count does not count distinct
workflow executions. Group membership appears in the trace inspector's Details
tab and links to Agents or Workflows, without adding synthetic span rows.

### Span kinds and evaluation structure

Set `datool.span.kind` in the OTel span's initial attributes for explicit kinds (`task`, `function`, `llm`, `tool`, `score`, `agent`, `workflow`, or `custom`). AI SDK operations map to `function`, individual model calls to `llm`, and tool calls to `tool`. A root OTel span with `datool.trace.root: true` represents only the trace container, so its direct children appear as top-level spans:

```text
task
  function
    llm
      tool
    llm
score
  llm
```

An evaluation can record task and score spans separately, with the judge model independent of the task model. `traceOpenAIChatFetch` instruments the judge's non-streaming Chat Completions requests, including per-attempt errors and the response's model and usage. It preserves the response for OpenAI's SDK. Do not apply that wrapper to AI SDK calls that already emit OTel spans. Other endpoints and streaming calls pass through without instrumentation.

### Persisted usage and cost

Every captured LLM span stores the exact response `model`, normalized `provider`, and `usage.input_tokens`, `usage.output_tokens`, `usage.total_tokens`, plus cached input, cache writes and reasoning counters when supplied by the provider. Raw provider attributes are retained. Total tokens are input plus output; cached input is a subset of input, and reasoning is a subset of output.

`cost.usd` is an **estimate**, calculated during export using TokenLens 1.3.1 and a cached models.dev catalog. The span also stores `cost.model`, `cost.resolution`, `cost.rates_per_million`, `cost.breakdown`, the catalog/version, and `cost.calculated_at`. The UI reads these saved values; viewing a trace never reprices it. Dated OpenAI model snapshots can resolve to the matching undated pricing identity while retaining the actual model name. Rates are catalog estimates, not provider invoices. The export queue refreshes the catalog at most once per hour, with a three-second timeout and one-minute retry backoff. Failed refreshes retain the last successful snapshot or bundled fallback. Quotes record the catalog fetch time; new catalogs never reprice existing traces. Explicit context tiers use the total input count before cache subtraction and apply to the full request. Set `pricing: { autoRefresh: false }` on `DatoolSpanProcessor` for offline use; `pricing.catalog` supplies custom rates.

The calculation restricts TokenLens to the exact provider's catalog to avoid same-name models from other providers. Cached tokens are removed from regular input before adding cache charges; reasoning is removed from regular output only when the catalog provides a separate reasoning price. Missing model, usage, or required rates produces `cost.status: missing` and no cost value, rather than zero.

Function, task, score and trace totals sum their descendant **LLM spans only**, never the AI SDK function's already-inclusive usage. `usage.source: descendant_llm_sum`, `usage.status`, `usage.llm_calls`, and `usage.known_llm_calls` describe coverage. `models` lists the actual models used. Cost rollups store `cost.priced_llm_calls` and `cost.status`; partial totals are saved as `cost.known_usd`, while `cost.usd` is present only when every LLM call has a price. Do not add wrapper totals to their children.

These attributes are stored in PostgreSQL with the spans/traces and returned by their existing APIs. They are visible in the inspector, trace-list Models/Tokens/Estimated cost columns, and projected under `attributes.metrics` for saved-view selectors such as `trace.attributes.metrics.totalTokens` and `trace.attributes.metrics.costUsd`, or collection filters such as `metrics.costUsd > 0.01`. Older captures without the judge response cannot recover its model or token usage; rerun them to obtain complete accounting.

## Manual tracing

`@datool/sdk` is the Node-only tracing client used by Datool v1. It posts a trace when work starts, posts each span as it starts, and patches every span and trace when it ends. The review workspace can therefore show a running trace and its nested graph before the workflow finishes.

The client records JSON values. Keep inputs, outputs, and attributes JSON serializable so they can be stored and selected later in a saved view.

```ts
import { createTracer } from "@datool/sdk"

const tracer = createTracer({
  baseUrl: process.env.DATOOL_TRACE_BASE_URL ?? "http://127.0.0.1:3000",
})

const session = await tracer.createSession({
  attributes: { source: "local-workflow" },
  name: "Account launch review",
})

await tracer.withSession(session.id, async () => {
  await tracer.trace(
    {
      attributes: { environment: "local" },
      input: { question: "What must be checked before an account launch?" },
      name: "Account launch review",
      operation: "account.launch.review",
    },
    async (trace) => {
      const sources = await trace.span(
        {
          input: { query: "launch checklist" },
          kind: "tool",
          name: "Retrieve launch checklist",
        },
        async () => ({
          sources: [
            { id: "policy-launch-checklist", title: "Launch checklist" },
          ],
        }),
      )

      return trace.span(
        {
          input: { sourceIds: sources.sources.map((source) => source.id) },
          kind: "agent",
          name: "Compose launch guidance",
        },
        async () => ({
          answer: {
            text: "Before launch, verify the source record and approval status.",
          },
          outcome: "ready_for_review",
        }),
      )
    },
  )
})
```

Calls made inside a `trace.span` callback inherit that span as their parent, so the following creates a nested graph without manually carrying IDs:

```ts
await trace.span({ kind: "agent", name: "Draft" }, async () => {
  return trace.span({ kind: "tool", name: "Lookup policy" }, async () => {
    return { policy: "launch-checklist" }
  })
})
```

The SDK uses these lifecycle requests:

| Event            | Request                                                    |
| ---------------- | ---------------------------------------------------------- |
| Create a session | `POST /api/sessions`                                       |
| Begin a trace    | `POST /api/traces` with `status: "running"`                |
| Begin a span     | `POST /api/traces/:traceId/spans` with `status: "running"` |
| End a trace      | `PATCH /api/traces/:id` with status, end time, and output  |
| End a span       | `PATCH /api/spans/:id` with status, end time, and output   |

If workflow code throws, `trace` and `span` patch the active record as `errored`, attach a short error name/message as attributes, then rethrow the original error. This preserves the failure in the trace graph without changing the application’s normal control flow.

## Run the deterministic demo

Start the local app, then run:

```bash
bun scripts/demo-trace.ts
```

Set `DATOOL_TRACE_BASE_URL` when the app is on a different local origin. The script executes two real local workflows with four spans each: retrieval, composition, a nested formatting task, and review. Their IDs are generated at run time, while their input/output shapes and graph are deterministic. Every demo trace and span includes `demo: true` metadata.

`runDemoWorkflow` in [src/lib/tracer/demo.ts](../src/lib/tracer/demo.ts) also returns a matching dataset specification, evaluator, and saved-view definition. Those are creation templates, so the in-app **Run demo** action can persist a fresh complete v1 review path without reusing a fixture ID.

The SDK is server/CLI code. It imports Node’s async context APIs and must not be bundled into a browser client.

### Repair missing cost quotes

`bun run scripts/backfill-missing-costs.ts --project <id> --model <exact-response-model> --after <ISO-date> --before <ISO-date>` previews missing quotes using a freshly fetched catalog. Verify that those rates apply to the selected historical window before applying. The window is limited to 31 days and 1,000 terminal traces, with at most 10,000 spans per trace.

Add `--apply --backup <private-jsonl-path>` to repair those quotes and their ancestor/trace cost totals. Each trace is locked and updated in one transaction after its before-image has been synced to the backup file. Existing priced LLM spans, tokens, and unrelated metadata are preserved. Missing usage stays unavailable. Re-running the same selection is a no-op after all eligible spans are priced. Generated database cost facts update with the stored attributes.
