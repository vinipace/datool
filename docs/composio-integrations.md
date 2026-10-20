# Connected apps and agent usage

Build uses Composio sessions for project-owned app connections and execution.
Customers connect and manage accounts in **Agent → Integrations**. Authorize in
a new tab, then return to Integrations and refresh the connection. In
**Agent → Actions → Create action → Connected app**, choose that account and a
tool. Save the action and apply the agent revision to make it available to live
conversations. The action editor links to Integrations and keeps its draft while
you manage accounts.
Google Calendar is an example; the installation controls which apps and tools
are offered. Existing human-approval guardrails, channel restrictions, procedures,
and simulation mocks apply to these actions too.

## Operator setup

Apply `0057_build_integrations_usage.sql` using the normal migration command.
Set these variables on both the web process and Build worker:

- `COMPOSIO_API_KEY`: a dedicated Composio project API key. Never expose it to
  browsers or store it in agent instructions.
- `DATOOL_COMPOSIO_APPS`: a JSON map from toolkit slug to `name`, `authConfigId`,
  `costNanoUsd`, `connectionCostNanoUsd`, and an explicit `tools` allowlist.

For example, the following is **illustrative configuration**, with a placeholder
Auth Config ID and an example internal rate of $0.001 per attempted call. It is
not a statement of Composio's price:

```json
{
  "googlecalendar": {
    "name": "Google Calendar",
    "authConfigId": "ac_REPLACE_WITH_YOUR_AUTH_CONFIG",
    "costNanoUsd": 1000000,
    "connectionCostNanoUsd": 0,
    "tools": ["GOOGLECALENDAR_EVENTS_LIST"]
  }
}
```

Create the Auth Config in the Composio project, confirm the desired OAuth scopes
and tool slugs in its catalog, and set a conservative internal rate covering the
installation's contract. Set `connectionCostNanoUsd` to cover any managed-app
or connection-priced add-on fees; zero is appropriate only when connections are
free under your Composio setup. It is a separate internal charge per OAuth
initiation attempt, including an attempt the user later abandons. Configure
write actions separately and review their permissions. An empty map disables new connections. Removing a toolkit or tool,
changing its Auth Config, or disconnecting its account blocks existing actions
at execution time too. OAuth setup, provider credentials, consent/app review and
scopes must be verified in the actual Composio/Google accounts.

Composio sessions use a stable server-derived identity for each organization +
project. Connections are shared by agents in that project, not by visitors across
projects. OAuth tokens stay with Composio. Datool stores account identifiers and
status, and never accepts an account ID or user ID from a visitor. Each execution
pins its exact connected account and a single approved tool. The direct-tools
preset, disabled sandbox, disabled proxy and disabled Instant execution prevent
bulk helpers or premium tools from bypassing per-call admission. Automatic file
upload/download and SDK telemetry are disabled.

## Usage and limits

The existing paid execution-credit allowance is shared across projects: Core $5,
Pro $25 per paid subscription period. App calls reserve their configured charge
atomically in the same ledger as funded scorers and sandboxes. No available paid
balance means no dispatch. Lowering the remaining balance with one concurrent
agent immediately reduces capacity for others. No overage is authorized.

Connection initiation also reserves its configured amount before the OAuth link
request, and is never retried automatically. Its charges appear in organization
and project integration spend, since a project connection is shared and has no
agent/conversation yet. Uncertain connection attempts use the same evidence-based
reconciliation workflow. The agent/conversation breakdown counts tool executions.

A completed or explicitly failed provider execution consumes the configured
per-attempt amount. This is an internal execution-credit charge, not a retrieved
provider invoice. A request blocked before dispatch releases its reservation.
Network failures, cancellations after dispatch, missing/invalid provider results,
and process crashes retain reservations until reconciled. Datool never retries
an execution automatically. The durable turn/tool-call identity prevents replay
of the same attempt. Session and provider log IDs support investigation; usage
records do not contain tool arguments, results, OAuth tokens or account credentials.
An agent deliberately issuing a new call is a new attempt and must reserve again.

Inspect uncertain funded operations with the existing maintainer command:

```sh
bun run scripts/execution-credits.ts pending --organization ORGANIZATION_ID
```

After confirming the result with Composio, use its documented `settle ...
--evidence` workflow. Include `usage.result` as `completed` or `failed` and the
provider log ID. Settlement updates both the credit ledger and Build usage. Do
not release a reservation merely because its request timed out or its period
ended. Changes to rates do not rewrite earlier ledger entries.

With cloud billing disabled, self-hosted installations record calls but do not
receive or enforce paid subscription credits. Their Composio bill remains their
responsibility. Enabling Composio is explicit even in this mode.

**Organization Usage** includes app credit spend plus input, output, cached-input
and reasoning tokens by project/agent and by conversation. The HTTP/CLI/MCP
operation `build_get_usage` also accepts `agentId` and `conversationId` for a
project-scoped breakdown. Totals cover the entire current paid period (UTC
calendar month without a paid period); breakdowns show the 100 most recently
active groups. Existing retained model traces are not backfilled into this new
meter. Cached input and reasoning are subsets of input and output, not extra
tokens. Missing reports are explicitly counted as incomplete.

Each model invocation is recorded before dispatch and its usage is persisted
before client-side tools run. A later failed step or ownership change does not
erase prior usage. Agent models currently use the project's own OpenAI/Gateway
key; their tokens are tracked but not deducted from Datool execution credits.
Only provider-reported numeric model costs are recorded; absent costs remain
unknown. Existing per-agent daily guardrails continue independently. Adding a
Datool-funded agent model would require a bounded per-request reservation at that
provider transport, as already used for the managed scorer model.

## API operations

The existing authenticated Build transport exposes `build_list_app_connections`,
`build_connect_app`, `build_refresh_app_connection`, `build_disconnect_app`,
`build_list_app_tools`, and `build_get_usage`. Read operations require `build:read`;
connection changes require `build:write`. Connect requires an idempotency key;
a repeated intent does not initiate another OAuth flow. A callback URL alone
cannot activate a connection: refresh checks its provider status and Auth Config.
Execution is available only through the existing applied-agent runtime, so a
browser or MCP caller cannot bypass the selected action or its usage admission.

## Verification and rollout

Run the integration and runtime tests against an explicitly disposable loopback
PostgreSQL URL. External Composio HTTP and model calls are mocked in the tests;
the actual SDK transforms, database migrations, agent loop, receipts, credit
reservations and aggregation execute locally. Storybook covers connection and
usage states. Before release, verify OAuth consent, read an event from a dedicated
test calendar, inspect its conversation/usage/log IDs, disconnect it, and verify
both revocation and insufficient-credit denial. No live account connection,
deployment or provider-invoice reconciliation is implied by local test results.

Provider references: [Composio sessions](https://docs.composio.dev/docs/configuring-sessions),
[existing harness integration](https://docs.composio.dev/examples/harness-integration),
[pricing](https://composio.dev/pricing). The installed SDK is pinned to 0.25.0;
recheck the cancellation and session interface adapter when upgrading it.
