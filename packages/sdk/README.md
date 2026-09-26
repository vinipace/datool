# @datool/sdk

Typed manual tracing and OpenTelemetry export for Datool. Requires Node 22.18+.

```sh
npm install @datool/sdk
```

Set `DATOOL_BASE_URL`, `DATOOL_PROJECT_ID`, and `DATOOL_API_KEY`. Use an organization API key with `traces:write` for ingestion and the corresponding read/write permissions for other resources.

```ts
import { createTracer } from "@datool/sdk"

const tracer = createTracer()
await tracer.workflow(
  {
    name: "Onboarding",
    group: { type: "workflow", name: "onboarding", version: "v1" },
  },
  async (trace) => {
    return trace.agent(
      {
        name: "Reviewer",
        group: { type: "agent", name: "reviewer", version: "v2" },
      },
      async () => ({ approved: true })
    )
  }
)
```

For existing OpenTelemetry instrumentation:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node"
import { DatoolSpanProcessor } from "@datool/sdk/otel"

const processor = new DatoolSpanProcessor()
const sdk = new NodeSDK({ spanProcessors: [processor] })
sdk.start()
// Run your instrumented application.
try {
  await processor.forceFlush()
} finally {
  await sdk.shutdown()
}
```

For applications already using OpenTelemetry (including AI SDK), use the
OpenTelemetry mode of the existing tracer factory. It uses your registered
provider and `DatoolSpanProcessor`; it does not make a second set of HTTP writes.
The default manual tracing mode above remains unchanged.

```ts
import { createTracer } from "@datool/sdk"

const tracer = createTracer({ transport: "otel" })
await tracer.workflow({ name: "onboarding", input: { userId: "123" } }, () =>
  tracer.agent({ name: "reviewer" }, async () => {
    // AI SDK calls with experimental_telemetry: { isEnabled: true }
    // become children of this agent automatically.
    return { approved: true }
  })
)

const stream = tracer.agentStream({ name: "assistant" }, () => generateChunks())
for await (const chunk of stream) consume(chunk)
```

OpenTelemetry mode provides `workflow`, `agent`, `span({ name, kind })` and
`agentStream`. Operation callbacks receive the native OpenTelemetry span.
Named invocations nested in an active Datool invocation share its trace;
otherwise they start a separate trace, including multiple agents in one HTTP
request. Groups are explicit and are never inferred from metadata. An optional
`version` (string or function) sets the default invocation version; individual
`group.version` values override it, including `null` for an unversioned group.

`agentStream` preserves lazy iteration, parent context, yielded values, iterator
inputs and return values. It forwards `next`, `throw` and `return`, closes spans
on completion/error, and marks consumer cancellation. It concatenates recorded
string chunks and retains the latest recorded non-string value; `mapOutput`
can select application-specific chunks (`undefined` skips a chunk). Recording
is bounded to 20,000 characters by default. Configure
`maxInputOutputCharacters`, or set `recordInputs` / `recordOutputs` to `false`
on an operation. Recording never changes the result returned to the caller.

The processor recognizes AI SDK text and structured-output model spans and
accounts for their tokens once. Its optional hooks keep application policy
outside the SDK:

- `shouldExport(span)` selects spans at start; default is to export all spans.
- `attributes` accepts an object or a function evaluated at span start, capturing
  request/workflow metadata consistently through completion.
- `transform(data)` transforms each lifecycle payload before transport, including
  inputs, outputs, attributes and errors. Use it for your redaction policy.
- `onTraceEnd()` runs once all selected spans in a trace have ended. Use it to
  schedule `processor.forceFlush()` with framework facilities such as Next.js
  `after()`. The SDK does not import or configure Next.js.

Existing OpenTelemetry instrumentation can continue to use the processor alone.

Declare named invocations in the span's **initial attributes**: `datool.group.type` (`agent` or `workflow`), `datool.group.name`, and optional `datool.group.version`. Set `datool.trace.root: true` when that span is the trace container. Metadata such as `agent.name` does not define grouping. Groups are not inherited by children.

Group membership does not change an operation's kind. In OTel mode, any generic
operation can specify a group while preserving its type:

```ts
await tracer.span({
  name: "Extract mentions",
  kind: "function",
  group: { type: "workflow", name: "Research", version: "v1" },
}, async () => extractMentions())
```

Direct API trace and span payloads also accept `group` independently of
`operation` or `kind`. Multiple step traces can share the same group. The
Agents/Workflows pages count member operations, not distinct workflow executions;
the trace inspector shows each membership in Details and retains original kinds.

Exports:

- `@datool/sdk`: `createTracer`, `DatoolTracer`, `createDatool`, `DatoolClient`, `RuntimePrompt`, prompt override, lifecycle and API types.
- `@datool/sdk/otel`: `DatoolSpanProcessor`.
- `@datool/sdk/context`: HTTP/call correlation helpers; authenticate endpoints separately.
- `@datool/sdk/openai`: `traceOpenAIChatFetch` for non-streaming Chat Completions that are not already traced.
- `@datool/sdk/contracts`: API types.

Queued delivery requires the Datool API, Redis, and ingestion worker. An HTTP 202 acknowledges queue acceptance. `forceFlush()` waits for the PostgreSQL receipt and rejects failed/timed-out delivery. Await it before shutdown. Manual tracing waits for persistence before completing each lifecycle operation. Direct delivery is available for synchronous local tests.

`DatoolClient.request` returns the API's `data` field; collection reads return pages. The client does not automatically traverse pages. Use the current server schema/contracts. This is Datool's JSON protocol, not an OTLP endpoint. Pricing uses TokenLens catalog estimates and preserves missing/partial coverage. The export queue refreshes models.dev pricing at most once per hour (three-second timeout), shares concurrent refreshes, and retains the last good catalog on failure. No trace data or Datool credentials are sent to the catalog. Context tiers include cached input when choosing a rate. `forceFlush()` waits for pricing before inclusive cost totals and delivery. Set `pricing: { autoRefresh: false }` for offline operation, or provide `pricing.catalog`, `pricing.fetch`, `pricing.refreshIntervalMs`, and `pricing.timeoutMs` to customize catalog handling. Saved traces retain the quoted rates and catalog fetch time.

## License

Copyright 2026 Vinicius Pacheco. Licensed under the [Apache License 2.0](./LICENSE).

## Native SDK

```ts
import { createDatool } from "@datool/sdk";
const datool = createDatool(); // DATOOL_BASE_URL, DATOOL_API_KEY, DATOOL_PROJECT_ID
const prompt = await datool.prompts.get("brand-extraction");
const result = await generateText({
  messages: prompt.render(caseVariables),
  model: resolveModel(prompt.model),
  output: extractionSchema,
});
```

`new DatoolClient(options)` exposes the same `prompts` API. Normal fetching needs
no `connect`, template engine or application cache. Provider resolution and the
output schema stay in the application. `get(slug, { version: 2 })` pins a published
version. The returned `RuntimePrompt` has typed text messages, `id`, `slug`,
`version`, `model`, `provider`, `metadata`, and `settings` (`temperature`,
`maxTokens`, `output`). Translate generation settings to your provider's parameter
names, for example `maxOutputTokens: prompt.settings.maxTokens` for AI SDK.
`render(variables)` accepts string values, throws with all missing variable names,
and returns a new message array. Dotted names are literal keys; substituted text
is never interpolated again or HTML-escaped.

```ts
await datool.prompts.withScope({}, async () => {
  datool.prompts.override("brand-extraction", { version: 2, model: "openai/gpt-4.1-mini" });
  const candidate = await datool.prompts.get("brand-extraction");
  datool.prompts.reset("brand-extraction");
});
// Equivalent: withScope({ "brand-extraction": { version: 2 } }, callback)
```

Each client has its own overrides. `override` replaces that slug's override
rather than merging it. It affects subsequent `get` calls; it cannot change
already returned prompts, in-flight lookups, or cached published definitions.
`override` and `reset` throw outside `connect`, `withDatoolRequest`, or
`prompts.withScope`. `get` works normally outside a scope. Nested callback scopes
inherit a copy of the parent's overrides; child reset removes the inherited
entry in that child only. Completion or failure clears the child and restores
the parent. Concurrent branches that need distinct mutations should each enter
`withScope`. `connect` always starts a fresh scope for each call and cleans it
up on success or failure. Await work inside the callback; detached background
work is not part of the invocation.

Caches are private to the client, including its server, project and credentials.
Pinned published definitions remain cached until LRU eviction. Latest-published
lookups refresh after 30 seconds by default (no stale-on-error fallback). Configure
`promptCache: { latestTtlMs: 0, maxEntries: 256 }` to disable latest reuse. TTL
must be 0–300,000 ms; capacity defaults to 256 and supports 1–10,000 entries.
Concurrent identical reads deduplicate, failed requests are never cached, and
each result is copied so caller mutations cannot corrupt cache entries. Revoking
a key or deleting a prompt does not invalidate a definition already cached by a
running process; create a new client to drop its cache immediately.

Published HTTP lookups also use the server's Redis cache, with a hard 60-second
maximum age and invalidation on save, publish and delete. Each HTTP request still
authorizes the key/project; Redis failures fall back to PostgreSQL. During a
missed invalidation, a latest lookup can retain an old response for the remaining
server lifetime plus the configured SDK TTL (at most 90 seconds with defaults).
HTTP responses use `no-store`; the SDK cache is explicit application behavior.
Run manifests bypass both latest caches and read one database snapshot. Pinned
version contents remain immutable regardless of either cache.


Standalone prompt fetching needs `prompts:read`. Connected dataset fetching also
needs `evals:read` and `traces:write`: each lookup authenticates the frozen run
configuration and awaits its provenance span write. HTTP applications import
`withDatoolRequest` from `@datool/sdk/context` and wrap their authenticated handler
to install Datool's invocation scope. `connect` installs it automatically.

Connected evaluations can install prompt overrides automatically; see [managed prompts](https://github.com/vinpac/datool/blob/main/docs/managed-prompts.md) for frozen run configuration, scopes, and provenance.
