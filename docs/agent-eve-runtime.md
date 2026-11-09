# Eve agent runtime

Datool runs hosted agents through Eve `1.0.0-rc.6` and PostgreSQL World `5.1.1`.
There is one engine. Database-authored agents do not require authored Eve files
or a separate build for each agent.

## Start locally

Use Node 24 and Bun. Configure these server-only variables on the web process,
Build worker, and Eve process:

```dotenv
DATABASE_URL=postgresql://...
WORKFLOW_POSTGRES_URL=postgresql://...
DATOOL_EVE_URL=http://127.0.0.1:2001
DATOOL_EVE_SECRET=<independent random secret of at least 32 characters>
DATOOL_PROVIDER_ENCRYPTION_KEY=<the installation's existing credential encryption key>
DATOOL_BUILD_ENABLED=true
```

`DATABASE_URL` contains Datool's application records. `WORKFLOW_POSTGRES_URL`
contains Eve's workflow checkpoints and queue; it can point to the same
PostgreSQL database. Keep the Eve listener on a private network. The internal
execution routes require the shared Bearer credential; Eve's diagnostic HTTP
routes require Basic authentication with username `datool` and the same secret.

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run eve:bootstrap
bun run eve:build
bun run eve:start
# In separate terminals, with the same environment:
bun run dev
bun run worker:build
```

`eve:start` defaults to port 2001; `DATOOL_EVE_PORT` overrides it. Supply the
environment to Node when starting directly, for example with the shell or
`node --env-file=.env.local scripts/start-eve.mjs`. Bun scripts load the local
application environment when invoked with `bun --env-file=.env.local run ...`.
Project model-provider keys are configured in Datool;
Eve never substitutes server-wide model credentials for a missing project key.

All three processes must remain running. `bun run dev` starts only the web app;
it does not start Eve or the Build worker. If Eve is stopped, accepted messages
stay queued. If the Build worker is also stopped, no process can recover them.
Keep their terminals open or run them under the local process supervisor.

The web request observes an execution for at most 30 seconds, or five seconds
of continuous runtime unavailability. It then returns `EXECUTION_PENDING` in
the error details with the saved conversation and turn IDs. This does not
cancel the work. The playground shows the saved-message state and polls for
the recovered reply; API callers can retry with the same request key.

The Docker image builds Eve and uses Node 24. Compose supplies its private
service URL and workflow database. Set `DATOOL_EVE_SECRET` before enabling Build,
then recreate `app`, `build-worker`, and `eve`. The release step bootstraps the
workflow database when Build is enabled. Procfile installations also run the
`eve` process and must set `DATOOL_EVE_URL` to that process's private address.

## Authoring and execution

Datool admits the conversation turn, verifies channel access, ownership, limits,
and Jev routing, then persists an immutable execution plan. The plan pins the
published agent revision, configuration, history, skill and action catalog
references, budget reservation, and authenticated execution identity. An
unpublished draft cannot affect an admitted turn. Publishing affects the next
turn without rebuilding Eve.

Eve resolves model, instructions and tools dynamically from that plan. It owns
model/tool iteration, checkpoints and replay. Each Datool turn has its own Eve
session, seeded with Datool's conversation history. Datool retains the customer
conversation, continuation, action, usage and trace records.

Deferred tools use Eve's `eve__search` and `eve__tool` protocol. Stable legal tool
names map back to original database action IDs. Skill instructions unlock only
their linked private actions. Tool execution rechecks project, channel,
published revision, conversation ownership, and approval rules. HTTP, MCP,
Shopify, app integrations, forms, widgets, handoff and procedure continuations
use their Datool execution boundaries.

Eve's native `bash`, `read_file`, `write_file`, `edit_file`, `glob` and `grep`
tools use a Datool sandbox provider connected to the configured environment and
drives. One environment stays available throughout a turn, including background
commands and Eve process restarts. Completion closes compute and commits drives;
the worker repairs missed cleanup. Environments have a ten-minute maximum lifetime.
The sandbox capability remains unavailable during simulations, restricted Jev
routes, and when actions require human approval.

Settings → Web access independently enables `web_fetch` and provider-managed
`web_search`. Public URL fetching retains Eve's private-network and redirect
checks. Search uses the project's existing model credentials: native search for
direct OpenAI and Exa through AI Gateway. The frozen published configuration gates
search before the provider request, including restricted routes and simulations.
Provider search charges are reported when the provider supplies a total cost;
missing prices remain unknown. See [agent environments and drives](agent-sandbox-drives.md).

The pinned Eve release uses Undici 8's dispatcher wrapper for public URL checks.
This repository keeps Undici 7 for other integrations. The Bun patch in `patches/`
routes only Eve's public-destination module to the `undici-eve` alias (8.12.4),
preserving Eve's DNS, redirect, response-size and private-network protections.

The bridge build leaves working-directory resolution until runtime so Nitro
does not package local operator data as assets. The application image separately
ships public assets and sandbox evaluator sources.

Jev runs before generation. A redirect or clarification route has no action,
skill or code execution capabilities. Global off and channel off settings are
applied to the frozen configuration. Daily model reservations grow before each
paid request, including discovered schemas and tool-result context. Interrupted
or unpriced requests retain usage uncertainty rather than being recorded as free.

Simulations run the same Eve engine with frozen configuration and tool mocks.
They cannot call live external tools or code environments. Both the run and
case lease must still belong to the admitting worker before model/tool work.

## Recovery

`eve:start` enables renewable PostgreSQL job locks with
`WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS=30`; upstream defaults disable recovery
of an abruptly killed worker until its long queue timeout. Use the same positive
value on every replica. The default workflow concurrency is 4 and pool size 8.
Separate installations or environments sharing a workflow database must use
different `WORKFLOW_POSTGRES_JOB_PREFIX` values; replicas of the same
installation share a prefix (default `datool_`). This prevents a worker from consuming a task whose
application data belongs to another installation.

A killed Eve process resumes the same workflow after its lease expires.
Completed tool steps replay their saved results. Datool also commits an action
dispatch claim before external work. An interrupted claim with an unknown
outcome blocks further model/tool execution instead of repeating a possible
side effect. Recovery does not assert exactly-once delivery to an external API.

The Build worker reconciles pending/running execution records every five
seconds. It dispatches plans whose original caller died and reads Eve's durable
stream when a completion hook was missed. Final projection into Datool is
transactional, fenced and idempotent. Human takeover or an expired simulation
lease prevents a stale run from writing a reply.

Recovery across a process restart is validated for the same compiled Eve
version. Eve deployment/version changes can strand older sessions; coordinate
upgrades with running work rather than assuming cross-version replay.

## Validate

Use a disposable PostgreSQL database, never production:

```sh
WORKFLOW_POSTGRES_URL="$DATOOL_TEST_DATABASE_URL" bun run eve:bootstrap
bun run test:eve
```

The suite starts actual Eve processes and uses PostgreSQL checkpoints. Only paid
vendor HTTP responses are synthetic. It checks database agents, draft/published
revisions, Jev and channel settings, approvals, private skill actions, tool
search, hard process termination, and missed-hook recovery. The runtime,
continuation, simulation, integration and channel test files also exercise the
real Eve boundary. Container-backed drive checks additionally require Docker
and `DATOOL_TEST_SANDBOX_CONTAINERS=1`.
