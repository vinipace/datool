# App connections and playground

For the canvas playground, declare your workflow and agent handlers in `datool.config.ts` and run `bunx datool connect`. It syncs the manifest automatically and starts a listener. See [Connected playgrounds](./connected-playgrounds.md) for the manifest format. The explicit single-handler and HTTP connections below remain supported.

Open `/playground` to register an HTTP app, select it, and run JSON inputs or chat with an agent. Use Refresh apps after connecting from another terminal. Connections persist locally in `.data/apps.json`; bearer tokens stay on the server.

## Local TypeScript

Install `npm install --save-dev @datool/cli` and use `npx datool`. Local TypeScript handlers require Node 22.18+ and erasable TypeScript syntax; compile TSX or code using compiler path aliases first. Before the first npm release, install the [packed CLI](./npm-packages.md).

Set `DATOOL_BASE_URL`, `DATOOL_PROJECT_ID`, and `DATOOL_API_KEY`. The organization API key needs `apps:write` to register connections and `traces:write` for instrumented handlers.

```ts
// local.ts — input mode
export default async function (input: { text: string }) {
  return { text: input.text.toUpperCase() }
}
```

```sh
npx datool connect local.ts --name "My app"
```

For an agent, the default function receives the full messages array:

```ts
export default async function (messages: { role: string; content: string }[]) {
  return { content: `You said: ${messages.at(-1)?.content}` }
}
```

```sh
npx datool connect local.ts --mode agent --name "My agent"
```

Keep the process running. The CLI imports your code and polls Datool through an
outbound authenticated HTTPS bridge, so the Datool server can be hosted remotely.
Local connections keep the same ID for the same absolute file path and Datool
server. By default code loads once; reconnect after edits or enable watching.

### Watch local code

```sh
npx datool connect --watch
npx datool connect ./local.ts --watch --name "My app"
```

Watching is opt-in (`--no-watch` explicitly restores the default). The supervisor
watches source/config files under the current project root and the target file's
project root, including imported project files. It watches `.ts`, `.tsx`, `.mts`,
`.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`, `.yaml`, and `.yml`; Git files,
`node_modules`, `.datool`, `.next`, `dist`, `build`, caches, coverage, `tmp`,
`temp`, `artifacts`, `test-results`, and `playwright-report` outputs
are excluded. Dependencies outside these roots, installed package updates,
non-source assets and environment files require a manual reconnect. Node's
normal TypeScript/import limitations still apply.

Edits debounce for 250 ms. A one-second source snapshot catches missed filesystem
events on Node and Bun; excluded directories are never traversed. Each candidate imports the manifest and its dependencies
in a fresh process, clearing module and runtime state. A syntax/import/manifest
error keeps the previous listener active; saving a valid edit retries. After
validation, the previous listener stops claiming work, finishes active handlers
and telemetry flushes, and delivers their results before handing off its relay
session. The mailbox remains online: queued calls and calls arriving during the
drain retain their original IDs and deadlines. Uncertain
exchanges retry with the same request ID; handlers are never silently replayed.
The replacement resyncs definitions (including schemas), resumes the same mailbox,
and rotates the session token so delayed requests from the old worker cannot
claim jobs or disconnect the replacement. Only never-claimed jobs can continue
in the new process. If the app definition changes or an app is removed, queued
calls for that definition fail explicitly before execution; they never run
against a different schema. Calls already resolved with an old revision are
also rejected. A source-only edit with an unchanged definition preserves queued
calls. Edits during a drain schedule another replacement after the prepared
candidate takes over, keeping a validated listener available. A failed
activation before accepting calls can be retried by saving a file; an unexpected
failure after accepting calls stops the watcher and asks you to inspect saved
calls before reconnecting.

Ctrl+C follows the same drain path. A long call or unavailable result endpoint
can delay shutdown/reload. Keep top-level imports free of application calls:
candidates load before the old listener drains. Watching does not pin handler
code for an entire multi-case evaluation; use a stable checkout without watching
for reproducible final runs. `--watch` on an HTTP URL is rejected; ordinary HTTP
registration is unchanged. Safe reload requires CLI 0.4.1+ and a hosted relay
advertising bridge protocol 2 and `session-v1`; upgrade the server first.
`--no-watch` requires bridge protocol 2 but does not require `session-v1`.

## HTTP

Use the Add app form or `datool connect https://example.com/call --mode input`. The endpoint receives a JSON POST with `{ "input": ... }` or `{ "messages": [{ "role": "user", "content": "Hello" }] }`. Return JSON or text. Agent responses can be strings or `{ "content": "..." }`; other JSON is displayed as serialized text. Responses are non-streaming, with a 60-second timeout. Reset clears the playground conversation.

`--datool`, `DATOOL_BASE_URL`, or `DATOOL_URL` selects the Datool server (default `http://127.0.0.1:3000`). `--project` overrides `DATOOL_PROJECT_ID`. Every API request includes the project and required API key. `DATOOL_APP_TOKEN` supplies the HTTP endpoint's bearer token. The CLI automatically creates its own token for local handlers.

## Automatic playground traces

`datool connect` sets `DATOOL_CONNECTION_ID` and `DATOOL_BASE_URL` before importing a local handler. Each invocation runs inside an `AsyncLocalStorage` context. `DatoolSpanProcessor` automatically adds `datool.connection.id` and `datool.call.id` to trace and span attributes; the call identity is captured at span start and retained through completion, including errors. Background traces outside a call carry only the connection ID.

The playground reuses the traces table and inspector, polls every three seconds, and filters server-side by connection. Choose Latest call to narrow to the most recent invocation, including failed calls. Existing traces from before this feature are not retroactively tagged. No handler response changes are required; apps still need to configure the Datool span processor and export their traces.

HTTP endpoints receive `x-datool-connection-id` and `x-datool-call-id`. In a Node HTTP adapter, import `withDatoolRequest` from `@datool/sdk/context` and wrap execution:

```ts
return withDatoolRequest(request, () => handler(payload))
```

Only accept correlation headers on an authenticated endpoint. Context does not automatically cross worker or process boundaries; those adapters must forward the IDs explicitly. `DATOOL_API_KEY` remains the authentication key and is separate from these non-secret correlation IDs.

For durable app definitions, multiple saved canvases, shared inputs, and multi-app bridges, see [Connected playgrounds](./connected-playgrounds.md).
