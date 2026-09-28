# Connect and run apps

## Compatibility

App convenience commands and the original outbound bridge are available in published CLI 0.3.0 against a server with app operations. Verify installed help and deployed capabilities; repository changes alone do not update either.

The resilient bridge requires a server supporting bridge protocol 2 and durable exchange receipts. The updated server still accepts older bridge clients with their original timing behavior. The new CLI checks protocol 2 during registration and refuses an incompatible server; app discovery or a successful doctor check does not establish this support. Doctor's CLI protocol 1 check is separate from the bridge protocol. Check the connected server's advertised capabilities instead of inferring support from an npm or repository version.

Use `datool apps list` / MCP `list_apps` to discover IDs, input/output schemas, connection types and availability. `datool apps get <id>` / `get_app` returns one definition. `apps:read` is required. HTTP availability means no bridge is needed, not that the endpoint passed a health check.

## Local bridge

In the app project, export `defineApps({ apps: [...] })` from `datool.config.ts` using `@datool/cli`. Each entry needs a stable `id`, `name`, object `inputSchema`, `outputSchema`, and local `handler`. A workflow receives the input object; an agent (`type: "agent"`) receives `input.messages`. Set `internalTracing: true` and `flushTelemetry` when your app can confirm trace delivery.

```ts
import { defineApps } from "@datool/cli"

export default defineApps({ apps: [{
  id: "example.echo",
  name: "Echo",
  type: "workflow",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  outputSchema: { type: "object" },
  handler: async (input: { text: string }) => input,
}] })
```

Run `datool connect` in that project, or `datool connect path/to/datool.config.ts`. With no path it uses the nearest project root containing `package.json` or `.git`, including from subdirectories. `datool apps sync <config.ts>` only registers definitions; it does not keep a handler online. Reconnecting unchanged definitions keeps their revision, and omitted definitions are retained. Agent schemas describe an object containing `messages`, even though the local handler receives the array.

`datool connect` syncs definitions and polls hosted Datool for jobs using authenticated outbound HTTP(S). The CLI executes handlers locally and pushes results back. No inbound laptop port or tunnel is needed. Registration and job exchange require `apps:write`; telemetry ingestion separately needs `traces:write`. Keep the CLI running; use opt-in watching when the installed CLI supports it, or reconnect after code/schema changes. Node handler imports still require Node-compatible modules; compiled JavaScript or direct Bun execution with `bun --no-env-file` can be appropriate for projects using extensionless TypeScript imports.

Bridges support up to 16 concurrent local handlers and cap the input job (including metadata) and JSON output at 768 KiB each.

### Bridge timing and recovery

With protocol 2, jobs are claimed once and lost exchange responses retry the identical request ID and body. The server stores receipts for claims and result acknowledgments. A crashed/disconnected worker does not cause automatic execution on a replacement worker. Inspect the saved run before explicitly retrying an app with side effects.

- Local handler execution, output validation and telemetry flushing share a timeout of at most 60 seconds, or the shorter execution timeout supplied by the server. A timeout cannot forcibly stop arbitrary handler code.
- Temporary transport failures and throttling retry within a two-minute consecutive interruption budget while retaining pending outputs. Retries honor server timing and stop if the next delay would exceed that budget; they do not extend handler execution. Dispatch and result delivery have separate server allowances, so end-to-end completion can take longer than 60 seconds.
- `evals wait --timeout` only limits how long the client waits for a run. Continue waiting on the same run ID or inspect its stages; use [evaluation recovery](../../datool-evaluations/SKILL.md#recovery-and-cancellation) when appropriate. An interrupted wait does not authorize a fresh app execution.

After transport retries are exhausted, completion can be uncertain. Inspect saved results and diagnostics before reconnecting or requesting recovery; never treat an unknown outcome as permission to replay the call. Older clients retain the original shorter session/job deadlines and do not provide this recovery window.

## HTTP webhook

Use Playground → New app or `datool apps register --input @app.json` / MCP `register_app`:

```json
{
  "app": {
    "id": "example.webhook",
    "name": "Example webhook",
    "mode": "input",
    "inputSchema": { "type": "object" },
    "outputSchema": { "type": "object" },
    "connection": {
      "type": "webhook",
      "url": "https://example.com/run",
      "method": "POST",
      "body": "input",
      "timeoutMs": 60000
    },
    "expectedRevision": 0
  }
}
```

Registration needs `apps:write` and does not invoke the endpoint. Use API `mode: "input"` or `mode: "agent"`; the manifest's `type: "workflow"` shorthand is normalized by the CLI, not by `register_app`. Webhooks are always available without a running bridge. HTTP settings support POST/PUT/PATCH, JSON headers, raw input (`body: "input"`) or Datool envelopes (`body: "envelope"`), and 1–60 second timeouts. For a workflow, these send the input object or `{ "input": ... }`, respectively. Agent webhooks receive the full input object containing `messages` in either body mode; they do not receive the bare messages array used by local agent handlers. Responses may be JSON or text and are validated by the app's output schema. HTTP request and response bodies are capped at 1 MiB. Non-2xx responses and timeouts fail the invocation; there are no automatic webhook retries or redirects. Production endpoints must resolve to public addresses unless the operator explicitly configures private-network access.

`datool connect https://example.com/run` is a registration shortcut: it creates a persistent webhook using `body: "envelope"`, then exits. Optional `DATOOL_APP_TOKEN` supplies its Bearer header. Use `apps register` for explicit stable IDs, schemas and other HTTP settings.

Send credential headers only through an authorized secret source. Values are encrypted at rest and omitted from reads; reads return header names. On edit, omit `headers` to preserve credentials or pass `{}` to clear them. Use the returned revision as `expectedRevision`; reload on conflicts. Changing a connection type requires that revision.

## Run and evaluate

Save this complete operation input as `run.json`, replacing the ID with an observed app and the input with a value matching its schema:

```json
{
  "id": "example.webhook",
  "input": { "text": "hello" },
  "requestKey": "example-smoke-1",
  "scorerIds": []
}
```

Use `datool apps run --input @run.json` or pass the same object to MCP `run_app`. The CLI also accepts the app ID positionally. `--input` holds the operation object, including its nested `input`; it is not the raw app payload. Omit `scorerIds` to use app defaults, or pass `[]` for an unscored invocation. Direct runs have no dataset expected output, so use criteria based on the input/output or a dataset evaluation when expected answers are required.

The call waits for the single invocation and returns the saved evaluation, including failures. Inspect its status and rows; command success alone does not mean the app or its scorers passed. Preserve the request key after uncertain delivery. If the request is still starting, inspect `list_eval_runs` using `metadata.agentRequestKey` before deciding on another execution. Changed app defaults or scorer versions can cause a retry conflict; do not bypass it with a fresh key. Required scopes: `apps:read`, `apps:write`, `evals:read`, `evals:write`, `scorers:read`, including when `scorerIds` is empty. This call can execute models and configured scorers within the user's authorized scope.

Both connection types use the same connected dataset evaluations: `start_eval_run` with `mode: "connected"`, app ID, dataset selection and scorer IDs; versions resolve automatically unless explicitly pinned. See the [evaluations skill](../../datool-evaluations/SKILL.md). Registrations, leases and bridge jobs use shared PostgreSQL storage; the executor remains process-bound. When the server advertises recover_eval_run/cancel_eval_run, follow the evaluation skill for checkpoint recovery and cancellation; shared job storage alone does not establish those capabilities. Confirm a small end-to-end run before a heavy campaign.


## Watch local edits

`datool connect --watch` (or `datool connect ./handler.ts --watch`) reloads local
source/config and imported project files after a 250 ms debounce. Check installed
CLI help for support. Watching is opt-in; `--no-watch` retains one-time imports.
Each replacement uses a fresh process and resyncs schemas. Invalid imports or
manifests leave the previous listener active until a valid edit. Active handlers
and telemetry finish and results are acknowledged before replacement; uncertain
exchanges are retried without replaying app calls. Ctrl+C also drains. Unexpected
listener failures after accepting calls stop watching; inspect saved calls before
reconnecting.

Scope: current/target project roots, extensions ts/tsx/mts/cts/js/jsx/mjs/cjs/json/
yaml/yml. Excludes node_modules, Git, .datool, build/cache/coverage outputs.
External imports, environment files and non-source assets require reconnecting.
`--watch` is rejected for HTTP URLs. Keep top-level imports free of app calls,
and disable watching for final evaluations that require stable handler code.

For native managed prompt configuration and authorization, read [managed prompts](prompts.md). The basic API is `const datool = createDatool(); const prompt = await datool.prompts.get(slug); prompt.render(variables)`. The application owns model resolution and output schemas. Connect installs invocation scopes automatically; outside connect use `datool.prompts.withScope(overrides, callback)` for experiments. `override`/`reset` throw without a scope. Connected dataset `promptOverrides` and all published defaults are frozen at run creation; generic input overrides remain separate.

When the installed bridge reports codeProvenance, retain its revision, dirty flag and fingerprint with the run. This is best-effort local Git identity, excluding ignored files and dependencies; it is not a deployable code snapshot or proof of remote code identity. Keep code stable for controlled comparisons.
