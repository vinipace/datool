# Datool Trace Explorer for ChatGPT

This is the read-only first version of the Datool plugin: one authorized project, filtered and cursor-paged traces, the shared trace inspector and timeline, captured span details, and selected evidence added to chat or sent with an investigation request. It has no write, review, evaluation, billing, or project-switching tools.

The source package is a template. Its `.app.json` is deliberately empty until a real personal MCP App is registered. The canonical production URL in `mcp.json` is the intended deployment address; this change does not deploy that endpoint or publish the plugin.

## Architecture and build

- `packages/chatgpt-trace-explorer/src/` owns the MCP Apps host adapter and standalone browser entrypoint. `components/plugins/trace-explorer.tsx` composes the existing `TraceListTable`, collection filter/histogram, and `TraceInspector`. The shared `useNavigation` hooks and `NavigationLink` use a Next adapter in the app and memory history in the plugin. A trace-read provider keeps the same inspector loader/cache while transporting plugin reads through MCP.
- `bun run build:chatgpt` bundles the UI into `public/mcp-apps/trace-explorer.html`; normal `dev` and `build` also run it. No Next page shell, direct iframe API fetch, embedded credentials, CDN, or worker is needed. Next traces the generated HTML into the MCP route deployment.
- `/api/mcp/trace-explorer` reuses the existing stateless MCP transport, project-bound authentication, tracer service and read operations. Public discovery exposes tool schemas and static UI only. Calls without valid authorization return `mcp/www_authenticate`; they never create a data service.
- `/.well-known/oauth-protected-resource/api/mcp/trace-explorer` advertises the read scope and existing Datool authorization server. DCR, S256 PKCE, project selection, membership checks, consent, refresh and revocation use the existing OAuth provider. The new resource accepts `traces:read` and optional `offline_access`, with five-minute access tokens.
- `open_trace_explorer` is the global entrypoint and accepts `{}`. `show_trace` presents a known trace. Exact span reads require both trace and span IDs.
- The UI detects host capabilities. OpenAI model-context/message extensions are optional; standard MCP Apps context/message methods work independently. Hosts without either capability offer Copy evidence. Context replaces the prior selection, Clear removes it, and investigation messages contain evidence themselves. Selection is capped at ten spans, chat evidence is bounded with explicit truncation, and large detail previews are clipped before syntax highlighting. Captured data is labeled as untrusted evidence.

No maintained Datool skills are copied into this application repository. They continue to ship from [vinpac/datool-skills](https://github.com/vinpac/datool-skills).

## Personal developer registration

1. Serve the built route from an HTTPS origin whose `BETTER_AUTH_URL` matches the origin. For a local test, expose only a disposable synthetic fixture through a temporary tunnel.
2. In ChatGPT Plugins, choose Add → Create MCP App. Use the HTTPS `/api/mcp/trace-explorer` URL and OAuth.
3. Confirm DCR and the discovered resource URL in Advanced OAuth settings. Keep `traces:read` selected; set `offline_access` as a base scope if refresh is wanted. Disable OIDC for this trace-only resource; it does not need profile or email scopes.
4. Create the personal connection, sign in to Datool, select a project, and approve read access. Copy its real `plugin_asdk_app_…` ID from the resulting plugin URL.
5. Generate the installable package with the real mapping:

   ```sh
   node packages/chatgpt-trace-explorer/scripts/package.mjs \
     plugin_asdk_app_REPLACE_WITH_REGISTERED_ID \
     https://YOUR_DEV_ORIGIN/api/mcp/trace-explorer
   ```

   Output goes to ignored `artifacts/plugins/datool-trace-explorer/`. The script writes `.app.json` as `{ "apps": { "datool-trace-explorer": { "id": "…" } } }` and updates the portable MCP URL. Personal IDs and tunnel origins stay outside source control.

6. Install that folder through a local marketplace or archive. In a new chat, open the Datool global entrypoint, filter traces, inspect one trace, select spans, Add to chat, and Investigate. Verify IDs and captured content in the chat, then test disconnect/reconnect. Personal registration, UI rendering, messages, and real-account data access are separate proof points.

The portable manifest uses root `plugin.json` plus `mcp.json`, with OpenAI presentation and registered-app mapping under `extensions.com.openai`. It follows the [current packaging guide](https://developers.openai.com/plugins/build/plugins), [MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui), [authentication guide](https://developers.openai.com/plugins/build/auth), and [OpenAI MCP extensions](https://github.com/openai/mcp-extensions).

## Verification

Use a disposable loopback PostgreSQL database, never the configured product database:

```sh
DATOOL_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/postgres \
  bun test tests/chatgpt-trace-explorer.test.ts tests/organization-auth.test.ts \
  tests/mcp.test.ts tests/trace-viewer-utils.test.ts tests/trace-viewer-data.test.ts
bun run check:styles
bun run typecheck
```

For desktop/mobile UI and host capability checks, run `tests/fixtures/mcp-apps/server.mjs` with that test database URL. It seeds an isolated synthetic schema and exercises the real transport and MCP Apps bridge. Open its local URL; `?standard` omits OpenAI extensions and `?bare` omits chat capabilities. SIGINT/SIGTERM clean up the schema.

`tests/fixtures/mcp-apps/oauth-server.mjs` is an optional disposable ChatGPT developer fixture. It requires `DATOOL_FIXTURE_ORIGIN` set to the temporary HTTPS tunnel origin. It reuses the production MCP route and OAuth endpoints with an isolated synthetic account. Its sign-in button bootstraps only that test account; it is never a production login path and does not prove access to a real user account. Stop it and the tunnel after testing.
