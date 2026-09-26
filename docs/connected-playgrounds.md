# Connected playgrounds

The Playground lists registered workflows and agents. Open an app to edit its schema-based inputs on the left and inspect the run’s captured traces on the right. Connecting starts a listener for the handlers declared in a manifest. Definitions and recorded traces remain available after it stops.

## Register and connect

Install `@datool/cli` and create `datool.config.ts`, exporting a manifest with `defineApps({ apps: [...] })` imported from `@datool/cli`. Each handler declares:

- `id`: an explicit stable ID, such as `misc.company-context`.
- `name`, `type` (`workflow` or `agent`, defaults to `workflow`), JSON `inputSchema` and `outputSchema`.
- Optional `defaultInput` and `evaluatorIds`.
- `handler`: the existing function to invoke. Handler code is never sent to the platform.

For connected apps, use object-shaped inputs. Agent apps declare a payload schema containing `messages`; the handler still receives the messages array. Schemas use JSON Schema draft-07 validation. String formats are not enforced; use explicit patterns when needed.

```sh
bunx datool connect
```

The CLI finds `datool.config.ts` at the nearest project root (a directory containing `package.json` or `.git`), including when invoked from a subdirectory. It loads that project's `.env` and `.env.local` automatically. Pass an explicit file path to use a different manifest. `--datool http://127.0.0.1:3000`, `DATOOL_BASE_URL`, or `DATOOL_URL` selects the server. Set `DATOOL_API_KEY` and `DATOOL_PROJECT_ID` (or `--project`). The listener sets `DATOOL_BASE_URL` before importing the manifest. With CLI 0.3.0, the listener initiates outbound requests to Datool. Hosted Datool can invoke local handlers without an inbound port or tunnel. Apply migration `0023_app_connections.sql` before using this connection protocol.

Every connect validates the handlers, syncs their definitions by ID, then registers an authenticated outbound bridge session. The CLI polls for jobs, executes them locally, and posts results back. Changed definitions increment their revision; unchanged definitions retain it. Omitted definitions are never deleted. A sync failure prevents the listener from starting. Successful exchanges refresh a 30-second lease. Unexpected process death marks apps offline within 30 seconds (plus the UI polling interval). One live listener may serve an app ID at a time. Reconnect after changing definitions or implementation code.

Existing manifests using `mode: "input"` or `mode: "agent"` remain compatible. A workflow receives the input object; an agent receives the messages array. Conflicting `type` and `mode` declarations are rejected. The standalone `datool apps sync <config.ts>` command is optional, for registering definitions without starting a listener.

## Inputs and runs

Open an app in **Playground**. Its input schema becomes collapsible form sections using the scorer editor layout. Strings, numbers, booleans, enums, nested objects, and arrays have typed controls. Open-ended or composed schemas use a JSON field. Declared defaults and the app's `defaultInput` populate the form; the server validates both input and output.

The **Input format** selector switches between **Form**, **JSON**, and **YAML**. Each format edits the same input object. Invalid code stays visible and blocks running or switching formats until it is corrected.

Agents also offer **Chat**, with a conversation and a message composer. Enter sends a turn; Shift + Enter inserts a new line. Every turn sends the complete `messages` history to the connected agent, appends its response, and selects that turn's captured traces. Responses arrive when the handler finishes. Chat preserves other input fields and unsent composer text when switching formats. A failed turn keeps its user message for retry without duplicating it. Opening a recorded run in Chat restores its input and completed reply so the conversation can continue.

**Run** calls the connected handler and records an invocation trace, including the output or failure. The panels resize and stack on narrow screens. Offline apps remain in the table, but cannot run until their listener reconnects. The result's `?run=` URL can be reopened or shared within the project.

## Captured traces

The listener scopes `datool.connection.id` and `datool.call.id` per invocation through AsyncLocalStorage. Datool records an invocation trace for every call, including plain handlers. Existing Datool instrumentation adds internal spans using those correlation attributes.

The result panel reads every trace page matching that call ID, includes the invocation, and keeps polling for late telemetry. Each trace retains its own root and hierarchy; clicking any span opens its payload in the shared trace viewer. Trace and span IDs jointly identify selections, so repeated span IDs in separate traces do not conflict. A failed read is reported explicitly instead of presenting a truncated result as complete.

The previous canvas and attempt APIs and their stored data remain available, but the Playground UI now opens apps directly. Every direct app run creates an experiment with a captured invocation trace, including failed and unscored runs. Selected scorers are pinned before execution. Recorded traces remain available for scoring through Scorers and Evals.

## HTTP apps and connection types

Use **New app** in Playground and choose **HTTP webhook**, or use `datool apps register --input @app.json`. The editor opens at `/p/<projectSlug>/apps/new`, using the same page structure as scorers and prompts. Existing apps expose **Connection settings** at `/p/<projectSlug>/apps/<appId>`; both routes support direct links and reloads. HTTP apps stay available without a bridge; availability does not imply a successful endpoint health check. Configuration includes URL, POST/PUT/PATCH, credential headers, raw input or Datool envelope, input/output schemas and a 1–60 second timeout. Header values are encrypted using the existing provider credential encryption key and never returned. Blank headers on edit preserve credentials; `{}` clears them. Updates use the current revision.

Raw input sends the input object directly. Envelope mode sends `{ "input": ... }` for a workflow or the agent messages payload. The app response is JSON or text, checked against its output schema. Datool sends call and invocation IDs for correlation. Non-2xx responses, oversized output, redirects and timeouts are invocation errors; Datool does not automatically retry side-effecting HTTP calls. Production destinations must resolve to public addresses. Operators can explicitly enable private destinations with `DATOOL_ALLOW_PRIVATE_APP_URLS=1` for a trusted network.

The connection schema is a tagged union in `src/lib/playground/connections.ts`; execution adapters implement `ConnectionAdapter` in `src/server/apps/transports.ts`. New types add their validated configuration, public projection/editor, resolution and adapter. Playground and evaluation consumers retain the same invocation contract.

App definitions, configuration, bridge leases and jobs use shared PostgreSQL storage. Existing local `playgrounds.json` is imported on first access, with old bridge sessions discarded. Migration does not require deleting the old file. Bridge input/output is bounded to 768 KiB, concurrency to 16 handlers, and execution to 60 seconds. A timeout does not forcibly stop arbitrary local handler code. Claims are never automatically redelivered to a replacement worker. Lost poll responses reuse the same request ID; identical completion retries are accepted. Completed transport records expire after a day when another invocation performs cleanup; canonical traces and experiments remain saved.

MCP and CLI expose `list_apps`, `get_app`, `register_app`, and `run_app` (`datool apps list|get|register|run`). The single-run operation accepts a stable request key and returns its saved experiment. Grant `apps:read`/`apps:write` in addition to evaluation/scorer permissions; telemetry separately requires `traces:write`. The evaluation executor remains process-bound: shared bridge storage is not a resumable batch scheduler.
