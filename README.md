# Datool

Datool is licensed under the [Apache License 2.0](LICENSE). Third-party code and
assets retain their respective licenses and notices.

Public product documentation is served at `/docs`. Edit its Markdown/MDX in
`content/docs/` and sidebar ordering in each folder's `meta.json`. Fumadocs generates
navigation, search, and Markdown exports from that content. `bun run check:docs`
checks internal links, sidebar coverage, and the runnable quickstart; the build
runs it automatically. Keep engineering plans and operational reports in `docs/`.

For production Docker/Dokku deployment and the isolated image acceptance test, see [Deploying with Dokku](docs/dokku.md).

For optional Google Cloud Logging integration, see [Find production logs](ops/gcp-logging/README.md#find-production-logs).
Keep installation-specific host and access details in a private operator runbook.
Generated reports, trace exports, screenshots, and recordings under `artifacts/`
are local outputs and are not distributed with the source.

Datool is a Next.js workspace for organization-scoped AI observability. Every trace, span, dataset, evaluator, evaluation run, saved view, and metric belongs to a project, and every project belongs to one Better Auth organization.

```text
organization → project → traces, spans, datasets, evaluators, eval runs, views, metrics
```

Better Auth provides Google and email-link sessions, organizations, and member roles. PostgreSQL is the only supported database for both Better Auth and tracer data; SQLite and `.data/datool.db` are not used.

## What it does

- Captures typed traces and nested spans through the Datool SDK.
- Stores project-scoped datasets and items, evaluators, evaluator versions, evaluation runs and results.
- Runs evaluator JavaScript and Python in isolated sandbox containers and persists scores, pass state, reasons, metadata, and sandbox failures.
- Provides saved result views and read-only semantic snapshots for traces, scores, evaluation runs, and performance metrics.
- Lets organization owners and admins manage projects. Members can work with project content but cannot manage projects.

All project and tracer access verifies the project's organization membership. An active organization in a session does not grant access to another organization's project.

## Self-hosting

Follow [Self-hosting Datool](docs/self-hosting.md) to configure magic links or
Google sign-in, generate secrets, and start the production Docker image.
Compose includes PostgreSQL, Redis, migrations, and the ingestion worker with
persistent volumes. The CMS and Cloud billing are disabled by default.

Code scorers require a sandbox provider. The guide covers remote providers and
an explicit local Docker option. The image never runs scorer code directly on
the application host when a sandbox is unavailable.

## Local setup

For UI development, follow [Shared product patterns](docs/shared-product-patterns.md). New collection pages should compose `CollectionPage`, `CollectionTable`, and the existing filter, saved-view, and inspector components. The guide identifies each behavior's owner and its verification contract.

Install Node.js 22.18+ (CI also tests Node 24), Bun 1.3.14, and Docker with Compose v2. Create a local environment file from the example:

```bash
bun install --frozen-lockfile
cp .env.example .env.local
openssl rand -base64 32
```

Set `DATABASE_URL` to a PostgreSQL database you control, `BETTER_AUTH_SECRET` to the generated value, and `BETTER_AUTH_URL` to the exact local server origin. `DATOOL_API_KEY` and its single `DATOOL_PROJECT_ID` binding authenticate SDK ingestion; keep both only in `.env.local` and never commit them.

Before starting the app, configure **Google OAuth** (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) or **email sign-in** (`RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL`). Set `AUTH_ALLOWED_DOMAINS` to your email domain. An empty allowlist denies sign-in unless you explicitly set `AUTH_ALLOW_PUBLIC_SIGNUP=true`. There is no default account or password. See [first-login configuration](docs/self-hosting.md#configure-the-first-login) for provider setup and callback URLs.

`bun install` also installs the local pre-push hook. Each push runs lint, the UI
style guard, TypeScript checks, and shared-control tests. Reinstall it with
`bun run hooks:install`, or run the checks directly with `bun run check:pre-push`.
An existing custom pre-push hook is preserved; follow the install warning to add
the checks to it. GitHub web edits do not run local hooks. See [CI checks](docs/ci.md)
for the remaining hosted checks and optional local Storybook commands.

For the bundled loopback-only PostgreSQL service (PostgreSQL 16 or newer):

```bash
docker compose -f compose.dev.yaml up -d postgres redis
bun run db:migrate
bun run dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, then create an organization and project. The root route redirects to the authenticated workspace. It includes Traces, Sessions, Evals, Datasets, Agents, and Workflows.

`BETTER_AUTH_URL` must match the browser origin and must use HTTPS in production. The development database configuration in `compose.dev.yaml` publishes only loopback ports and uses separate local Docker volumes. Start `bun run worker:ingestion` in a second terminal for queued ingestion.

Before promoting a Vercel preview or production deployment, configure a unique `BETTER_AUTH_SECRET`, the exact deployed `BETTER_AUTH_URL`, and the deployment's PostgreSQL `DATABASE_URL`. The secret and public origin must be configured per deployment environment. Normal `bun run build` remains database-free. Vercel runs `vercel.json`'s deployment build command, which logs a hashed database-target fingerprint and schema, applies the additive migrations to that deployment's injected database, and validates the Better Auth schema before the normal Next.js build. It never logs a connection string or auth secret.

## SDK ingestion

Install `@datool/sdk` in your calling app and `@datool/cli` for local connections and resource sync. See [npm packages](docs/npm-packages.md) for pre-release tarball installation, verification, and publishing.

Python applications use the [Python SDK](packages/python-sdk/README.md), including
automatic LangChain, LangGraph, ReAct, and Deep Agents tracing. See
[package releases](docs/package-releases.md) for npm/PyPI distribution and the
one-time trusted publisher setup.

The SDK sends typed trace lifecycle requests to the project API. Supply the project identifier explicitly so server-side authorization can enforce the project boundary:

```ts
import { createTracer } from "@datool/sdk"

const tracer = createTracer({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.DATOOL_API_KEY,
  projectId: "project-id",
})

await tracer.trace({ name: "my-workflow", input: { prompt } }, async () => {
  // create spans and return the workflow result
})
```

The **Load sample workflow** action uses this same ingestion path. It creates a trace and spans, then links a dataset item, evaluator, eval run, and saved result view; it does not insert a static UI-only fixture.

## API and authorization

Launch access supports Google OAuth and passwordless email links; email/password sign-in and registration remain disabled. For Google, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. For email links, set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to a sender verified in Resend. Links expire after 10 minutes, are stored hashed, and can be redeemed only once. The same email-link flow signs in existing users and creates verified new accounts after redemption.

Set `AUTH_ALLOWED_DOMAINS=yourcompany.com,partner.com` for either method. Domains are comma-separated, case-insensitive exact matches (subdomains must be listed separately). Google requires verified email; email links prove ownership through redemption and recheck the allowlist at that point. An unset or empty allowlist denies every new sign-in. Restart the server after changing configuration. Existing sessions are not revoked by this sign-in restriction.

Better Auth is mounted at `/api/auth`. Cookie-authenticated mutations require an `Origin` equal to `BETTER_AUTH_URL`; missing or foreign origins are rejected.

| Resource | Ownership | Access |
| --- | --- | --- |
| Projects | organization | owners and admins manage; members read |
| Traces, spans, datasets, evaluators, evals, views, metrics | project | project members, with SDK writes also requiring the API key and project scope |

Project API responses use `{ project }`, `{ projects, page, pageSize, total }`, `{ record }`, or `{ records, page, pageSize, total }`. Tracer APIs use `{ data: ... }`. Errors use `{ error: { code, message, details? } }`; unauthenticated requests receive `401`, denied members `403`, and a resource absent in its requested project `404`.

## Verification

Run the static checks:

```bash
bun run typecheck
bun run lint
```

The test suite requires a separate, explicit loopback PostgreSQL target. It never reads `DATABASE_URL`; unset it for the test process and provide `DATOOL_TEST_DATABASE_URL`. Each database test creates and drops a random schema plus its own organization and project fixtures.

```bash
docker compose -f compose.dev.yaml up -d postgres redis
env -u DATABASE_URL \
  DATOOL_TEST_DATABASE_URL=postgresql://datool:datool@127.0.0.1:5432/datool \
  bun test
```

Do not point `DATOOL_TEST_DATABASE_URL` at a shared, preview, or production database. The helper rejects non-loopback hosts and a value equal to `DATABASE_URL`.

Run the disposable production self-hosting acceptance test with Docker and local Playwright browsers available:

```bash
bun run test:self-hosting
```

It builds the production image and proves magic-link login, organization/project creation, authenticated trace ingestion, sandbox opt-in, CMS off/on, and persistence across container recreation. It uses isolated services and fixture credentials, captures mail locally, and removes its containers and volumes afterward. See [self-hosting](docs/self-hosting.md#acceptance-checks) for details.

`bun run verify:v1` and `bun run verify:semantic` exercise a running local server's typed trace/span ingestion, dataset and evaluator links, evaluation runs, metric aggregates, saved views, and read-only semantic snapshots. Do not run these commands against a production database.

See [bounded data reads](docs/bounded-data-reads.md), [connected evaluations](docs/connected-evaluations.md), and [CI checks](docs/ci.md) for current contracts and verification commands.

## Agent workflows

The MCP and CLI share trace investigation, scorer versions/testing, evaluation runs and CI gates, dataset snapshots, and analytics/navigation operations. See [the foundation guide](docs/agent-foundations.md). Agent skills are maintained in [`skills/`](skills/README.md); install the complete pack with `npx skills add vinipace/datool --skill '*'`.

## Contributing and security

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull requests. Report vulnerabilities privately using [SECURITY.md](SECURITY.md). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency and asset attribution.
