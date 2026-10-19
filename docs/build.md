# Build: customer experience agents

Datool Build is source-available under [Elastic License 2.0](../LICENSES/Elastic-2.0.txt).
Hosted or managed offerings that expose a substantial set of Build's features
require a separate commercial agreement. See [Licensing](../LICENSING.md) for
the distinction between running your own agents and offering Build as a service.
Observe, Test, and the SDKs remain Apache 2.0.

Build adds hosted customer-facing agents alongside Datool's existing Observe
and Test tools. A managed agent has instructions, model settings, knowledge,
actions, procedures, widgets, revisions, and channel connections. Conversations
execute on the server and persist in PostgreSQL; the customer's SDK process is
not required to keep an agent online.

The implemented channel adapters are Website, Telegram, and WhatsApp (Embedded Signup and Business App coexistence). Voice, additional
messaging providers, and a Portuguese dashboard are outside this implementation.
Additional adapters remain extension points and are not offered as available connections.

## Start the worker

Build requires the web process, the checked-in database migrations, and a
long-lived Build worker. Run migrations using the installation's normal release
procedure before starting the new version. Do not run test migrations against a
customer database.

```sh
bun run worker:build
```

Docker Compose includes a separate `build-worker` service. The Procfile process
is named `buildworker`. Run at least one instance of it in addition to the
existing ingestion worker. It uses independent loops for channel messages,
Telegram polling, procedure wait resumption, knowledge indexing/resync, simulations, and campaigns so a
crawl does not block customer replies.

The web process and Build worker must use the same PostgreSQL database,
`BETTER_AUTH_URL`, and encryption secret. Channel credentials and all HTTP
action headers use the existing provider credential encryption. Keep
`DATOOL_PROVIDER_ENCRYPTION_KEY` stable, or keep `BETTER_AUTH_SECRET` stable when
using its fallback. Back up that secret separately from the database.

## Connect the first Telegram agent

1. Sign in, select the customer project, and configure its model-provider key in
   Project settings.
2. Open **Build → Agents → New agent**. Set the instructions, provider/model,
   and guardrails. Save and apply the configuration that should receive traffic.
3. Add knowledge sources and wait for indexing to finish. Test answers and
   action behavior in the agent playground before connecting a customer bot.
4. In the agent's **Channels** section or **Build → Channels**, connect Telegram.
   Enter the BotFather token into the password field. Do not put tokens in
   instructions, metadata, source text, screenshots, or MCP transcripts.
5. Select **Polling worker** for a test without a public inbound URL. Select
   **Webhook** for a public HTTPS installation. Registering polling removes the
   bot's existing webhook; use a dedicated test bot when validating.
6. Start the Build worker and send the bot a message in Telegram. Verify the
   received message, generated reply, conversation record, and trace. Then
   exercise human takeover, a human reply, and return to AI.

Webhook registration uses `DATOOL_PUBLIC_URL` when set, otherwise
`BETTER_AUTH_URL`. Telegram sends to
`/api/build-webhooks/telegram/<connection-id>`. Admission requires the registered
Telegram webhook secret and stores the inbound update before acknowledging it.
Retries of the same provider event reuse the durable message.

The Telegram adapter uses grammY for Bot API requests and the existing durable
Build worker for polling and delivery. Connecting a bot validates its token with
Telegram's `getMe` method before marking the channel connected. Both the web
process and worker need outbound HTTPS access to `api.telegram.org`; polling
removes the need for a public inbound URL, but still requires that outbound
connection. A network timeout does not mean Telegram rejected the token.
Registration retries transient network failures up to twice. Calls that discard
pending updates are not retried, and message delivery remains governed by the
durable worker so an uncertain send cannot silently produce duplicate replies.

Local automated tests use
the provider transport boundary; they do not prove a real bot token, public TLS,
or customer account configuration works.

## WhatsApp

See the [WhatsApp setup guide](../content/docs/guides/whatsapp.mdx) for Meta app review, environment variables, webhook subscriptions, customer signup, coexistence, MCP tools, and the live verification checklist. Apply migration `0055_whatsapp_channel.sql` before enabling it.

## Publish web chat

Create and connect a Website channel. Its hosted page is
`/chat/<connection-id>`. Set `DATOOL_PUBLIC_URL` to the canonical public origin
(or use `BETTER_AUTH_URL` when both are the same). The signed visitor context
uses this origin consistently for session creation, messages, and history.
Configure the channel's allowed origins for the sites that will embed it.
The same conversation experience can be embedded:

```html
<script
  src="https://datool.example.com/datool-widget.js"
  data-channel-id="YOUR_WEBSITE_CONNECTION_ID"
  defer
></script>
```

**Help Page** is a separate card in Channels for a full-page help center.
Its editor autosaves the page title, favicon, branding, welcome content,
resource cards, sidebar links, theme and localization. The live preview supports
real conversations and per-message feedback. **Deploy** opens a sheet with
visibility controls and the hosted `/chat/<connection-id>` link; localhost
links remain local to the developer's computer.

In **Display → Sidebar buttons**, add a primary button or regular buttons with
labels and HTTP(S) destinations. Each button can be hidden or removed; changes
autosave and appear above conversation history. Resource cards are configured
separately and existing links stay visible unless explicitly hidden.

The Help Page sidebar lists the signed visitor's previous conversations. Starting
a new chat preserves those threads, and selecting one restores its messages and
title in the header. History is scoped to the visitor and channel. While the
worker prepares a reply, the typing indicator stays visible until the response
arrives, then transitions into the message.

Help Page and Chat Bubble share the `web` transport, signed visitor sessions,
runtime and trace feedback. `config.bubble.layout = "help_page"` selects the
full-page presentation, with page-specific settings in `config.bubble.helpPage`.
Existing connections default to the bubble layout.

The widget uses a signed visitor session. A conversation ID alone is not an
access credential. Visitor-provided context is untrusted customer data and must
not be used as verified customer identity or authorization for a privileged
action. Use server-authorized customer records in tools that access private
customer systems.

## Authoring and operations

When an agent is open, the main sidebar shows **Agents / agent name**, with
Overview, Instructions, Appearance, Guardrails and the other agent sections
nested underneath. The parent link returns to the agent list. The same links
are available in the mobile sidebar drawer; switching sections preserves an
unsaved draft. Actions, procedures, and widgets are selected from a list before
editing. Advanced identifiers and JSON configuration stay in expandable sections.
On narrow screens, customer details open in a sheet.

Widgets are authored as JSX in Code, with an editable Zod Schema and JSON
example data under Default data. Export a default React component receiving
`{ data }`; built-ins include Box, Col, Row, Text, Card, Button, Form, List,
and Image. React hooks and imports from `react` or `@datool/widgets` are supported.
The schema exports a Zod schema (imports from `zod`) and validates and parses
state data before preview or customer rendering. Code and schema run only in
an isolated iframe. Syntax is also checked when saving; server code never
evaluates widget source. Connect named Functions to agent actions, then invoke
one with `<Button onClickAction="requestDemo">Request a demo</Button>`.
The runtime admits only actions from the widget revision pinned to that
conversation. Existing component definitions open as JSX and convert when
saved; previously issued conversations retain their original definition.

| Area                      | Purpose                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Agents                    | Configuration, applied revisions, cloning, and archive lifecycle                                   |
| Knowledge                 | Text, Q&A, document extraction, website/sitemap crawling, indexing, refresh, retrieval, provenance |
| Actions                   | Validated HTTP/client/widget/handoff operations with channel and approval constraints              |
| Procedures                | Bounded steps, conditions, variables, action references, and conversation continuations            |
| Playground                | Hosted runtime with conversation and tool evidence                                                 |
| Inbox                     | Conversations, tickets, human ownership, notes, replies, routing, macros, and satisfaction records |
| Contacts                  | Identities, custom attributes, collected data, imports/exports, and leads                          |
| Campaigns                 | Audience snapshots, suppression, scheduled admission, and channel delivery receipts                |
| Dashboards                | Customer experience template with conversation activity, inbox, handoffs, and satisfaction metrics |
| Suggestions               | Feedback and knowledge gaps                                                                        |
| Simulations               | Frozen configurations, customer scenarios, mocked actions, transcripts, and explicit verdicts      |
| Copilot                   | Proposed changes, review, approval, application, and audit history                                 |

Contact details show **Connected accounts**, with a separate external ID and
connection name/status for each linked channel identity. **Primary external ID**
is the contact-level reference used by imports and integrations; it may come
from an application or be generated by a channel. The existing
`build_list_contact_identities` MCP operation returns the same account IDs and
connection summaries, scoped to the current project. Identities without a
matching connection remain visible.

Open **Dashboards → New dashboard → Customer experience** to create an editable
dashboard from the template. Its date filter applies to all widgets; channel,
event type, and status filters can be set in individual widgets. Conversation
and contact totals count distinct activity, tickets use their creation date,
and satisfaction uses the survey request date. Missing ratings are excluded.
The old `/build/analytics` address redirects to Dashboards.
MCP clients can use `list_dashboard_templates` and pass the chosen `config` to
`create_dashboard`. Customer experience measures also appear in the shared
metrics catalog for custom queries and widgets.

Knowledge supports text-based PDF and DOCX plus plain text, Markdown, CSV, JSON,
XML, and HTML. Scanned PDFs require text extraction/OCR before upload. Indexing
publishes a new source revision atomically and retains the previous index when
a refresh fails. Source deletion revokes retrieval. Retrieval reports source
provenance; it must not be described as a vector index.

## MCP and HTTP

Build UI, HTTP, CLI, and MCP share one operation registry. MCP clients use the
existing `/api/mcp` endpoint and request the appropriate scopes:

- `build:read`: inspect agents, content, conversations, configuration, and results.
- `build:write`: manage configuration and customer operations.
- `build:run`: execute agents, simulations, and supported job operations.

Use `build_describe_operations` to discover the authorized operations and their
current JSON input schemas, body limits, revision requirements, and retry
policy. A read-only client does not receive write or run tools.

`build_record_feedback` accepts `conversationId` and `messageId` to attach a
customer rating to the response's runtime trace. The trace shows one current
**Customer feedback** score (Helpful, Not helpful, or Unrated); the operation
ledger retains every change. The server resolves the trace from the message,
never from a client-supplied trace ID. Preview and signed web-channel feedback
use this same path. Ratings without a message identity remain analytics
evidence and are not assigned to an arbitrary turn.

The HTTP counterpart is `POST /api/build/<operation-name>`. Organization API
keys require `Authorization: Bearer ...` and `x-project-id`; browser requests use
the signed session and selected project. Required permissions are enforced
again by the operation dispatcher.

```sh
datool build tools
datool build tools build_create_agent
datool build call build_create_agent --input '{"name":"Customer support"}'
```

For retried writes, keep the same idempotency key and the same input. Use a new
key for a new user intent. Revision-controlled writes also require the revision
the editor read. An outdated editor must reload and reconcile; it must not
silently overwrite another operator's changes.

## Delivery and security boundaries

Customer channels share the same guarded runtime. Agent/channel/project
relationships are validated at admission and execution. HTTP tools and crawlers
use a public-internet-only transport with DNS pinning, bounded responses, and
explicit redirect handling. They cannot call loopback or private network hosts,
including during local development.

Human takeover advances the ownership fence so an older AI turn cannot append
an answer after losing ownership. Queue workers use persisted claims and
recovery rather than background promises attached to web requests.

Procedure waits are scheduled durably and resume automatically through the
Build worker. Migration `0051_build_wait_jobs.sql` must be applied before
starting the updated worker.

Telegram has no general send-message idempotency key. If the provider might have
accepted a send before the connection failed, the result is uncertain. Such a
delivery needs inspection before retrying; claiming exactly-once external
delivery would be incorrect. Compare Datool's delivery receipt with the actual
Telegram conversation when resolving uncertainty.

Country restrictions require trustworthy country information from an ingress
that supplies it. A Telegram user's language or phone format is not proof of
their current country. Do not describe that information as geolocation.

## Verification

The Build behavior tests require an explicit disposable loopback PostgreSQL URL.
They create isolated schemas and never use `DATABASE_URL` as the test target.

```sh
DATOOL_TEST_DATABASE_URL=postgresql://test@127.0.0.1:5432/test \
  bun test tests/build-*.test.ts

DATOOL_TEST_DATABASE_URL=postgresql://test@127.0.0.1:5432/test \
  bun run scripts/test-build-e2e.ts
```

The end-to-end harness copies the app to an isolated directory, creates test
authentication, starts Next and the Build worker, exercises the browser and MCP
over HTTP, and stores screenshots/report under ignored `artifacts/build-e2e/`.
It requires Chrome. By default, it does not contact a live model or a Telegram bot.
It exercises an HTTP action against Postman's public echo service using only
synthetic order data. Add `--live-model` to use the local `OPENAI_API_KEY` for
grounded customer replies, simulations, and Copilot checks. The harness stores
that key encrypted in its disposable project and removes the test schema at
the end; provider environment credentials are not inherited by Next or the
worker. Add `--production` to build and run the compiled application with
production settings behind a disposable local HTTPS endpoint. This mode requires
OpenSSL and accepts its generated certificate only in the isolated test clients;
it does not change the machine's trust store or internet certificate checks.
`--production-compile` checks compilation but runs the browser suite in development
mode. Neither option deploys the app or sends Telegram messages.
The browser checks also create contacts, campaign drafts, and test scenarios;
visit every Build page and agent section at desktop and mobile widths; and check
draft preservation and keyboard focus in mobile details.

Before customer deployment, use the release verification evidence together with
an authenticated live check of the intended bot, model provider, public origin,
and worker deployment. Passing local tests does not establish those external
conditions.

### Organization teams

Support teams and their membership belong to the organization and can be assigned
to tickets in any of its projects. Routing rules and conversations stay project
scoped; availability and workload capacity are shared across the organization's
projects. Migration `0054_organization_teams.sql` preserves team IDs, memberships
and assignments, disambiguating legacy duplicate names instead of merging groups.

The Inbox Details team picker creates teams and manages members in a sheet. People
are selected by name and avatar; choosing a team restricts the assignee picker to
its members. The same capabilities are available through MCP: `build_create_team`
and `build_update_team` accept `memberIds`, `build_list_teams` returns membership,
and `build_list_organization_members` supplies the authorized people directory.
Cross-organization teams are rejected by domain checks and database constraints.
