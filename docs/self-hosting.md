# Self-hosting Datool

Datool runs as a production Next.js app plus an ingestion worker, PostgreSQL, and
Redis. Docker Compose persists the database, Redis queue, and uploaded files.
The application image runs as a non-root user. The CMS, Cloud billing, and
Datool-funded execution are off by default.

## Configure the first login

Copy `.env.self-hosting.example` to `.env`. This is Compose's configuration file;
`.env.local` is for source development and is not used by this stack. Both are
ignored by Git and excluded from image builds.

```sh
cp .env.self-hosting.example .env
chmod 600 .env
openssl rand -hex 32
```

Run the generator separately for `POSTGRES_PASSWORD`,
`DATOOL_ALERT_READER_PASSWORD`, and `BETTER_AUTH_SECRET`, and enter the results in
`.env`. Use hex database passwords so the generated connection URLs need no
escaping. Keep these values stable across restarts and back them up securely.
The auth secret also protects saved provider credentials unless you configure a
separate `DATOOL_PROVIDER_ENCRYPTION_KEY`; changing it can make those credentials
unreadable. Changing the Postgres password in `.env` does not rotate an existing
database user's password.

Set `BETTER_AUTH_URL` to the exact public HTTPS origin, such as
`https://datool.example.com`. Configure your TLS reverse proxy to forward to
`127.0.0.1:3030`, preserve the public `Host`, and set `X-Forwarded-Proto: https`.
For a proxy in another container, attach it to the Compose network and route to
`app:3000`. The Compose file deliberately publishes only a loopback app port;
PostgreSQL and Redis have no host ports. `DATOOL_HTTP_PORT` changes the upstream
port, not the public origin. Production auth requires HTTPS even for a local
production-image trial; use a locally trusted TLS proxy for that case.

Choose at least one login method:

- **Magic link:** set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to a verified Resend
  sender. Enter your email at `/sign-in`, then open the one-use email link.
  Links expire after ten minutes. Resend is also used for organization invites.
- **Google:** create a Google web OAuth client and set `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET`. Register the exact redirect URI
  `<BETTER_AUTH_URL>/api/auth/callback/google`. Complete Google's consent-screen
  configuration, including test users while the OAuth app is in testing.

Set `AUTH_ALLOWED_DOMAINS` to your exact email domain(s), comma-separated.
Subdomains must be listed separately. An empty list denies new sign-ins unless
`AUTH_ALLOW_PUBLIC_SIGNUP=true` deliberately allows anyone with a verified email.
Domain access allows users to create their own organizations; it does not grant
membership in someone else's organization. Password signup is disabled. Google
login alone works without Resend, but sending organization invitations requires
Resend too.

## Start and use the application

```sh
docker compose up --build -d
docker compose logs -f migrate app worker
```

Compose validates the login settings, runs application migrations and provisions
a restricted alert reader before starting the app and worker. A missing login
provider, access policy, HTTPS origin, or strong auth secret stops startup with
an actionable configuration error. Provider credentials are checked for
presence here; the real login verifies that they work.

1. Open your HTTPS origin and sign in with Google or a magic link.
2. Create an organization, then a project.
3. Create a project API key with trace-write permission. Configure your calling
   application with the public `DATOOL_BASE_URL`, project ID, and key; follow the
   [SDK quickstart](../content/docs/get-started/first-trace.mdx).
4. Send a trace, wait for the worker to persist it, and open it in Observe.
5. Configure a sandbox as described below before running a JavaScript or Python
   scorer. LLM scorers also need a project model-provider key.

The application has no pre-created admin, sample account, or default password.
A `/sign-in` health response proves the web process is responding; it does not
prove email delivery, OAuth consent, worker persistence, or scorer execution.

```sh
docker compose exec worker bun run ingestion:jobs status
docker compose down
docker compose up -d
```

`down` preserves data. **`down -v` deletes the installation's volumes.** Back up
PostgreSQL and the files volume, and protect the configuration secrets. Redis
AOF holds queued work; preserve it through restarts. App and worker share the
files volume. For upgrades, take a database backup, review migrations, rebuild,
run `docker compose run --rm migrate`, then recreate app and worker with
`docker compose up -d`. Do not assume application rollback reverses migrations.

## Code scorer sandboxes

Code scorers execute outside the app process. With no working provider, scoring
fails with a saved configuration error and no score; it never falls back to
executing code directly on the application host.

For an installation shared with untrusted users, configure **Modal** or
**Vercel Sandbox** in the project's **Project settings → Sandbox providers**, test the
connection, and make it the default. Each project supplies its own credentials;
self-hosting does not require Datool Cloud billing. Only configure providers
whose infrastructure and execution costs you control.

For a dedicated Docker host operated by trusted administrators, an optional
Compose override connects the app and worker to the local Docker daemon:

```sh
docker pull node:22-bookworm-slim
docker pull python:3.13-slim
# On Linux, get the numeric group of the socket:
stat -c '%g' /var/run/docker.sock
# Set DATOOL_DOCKER_GID to that number in .env, then:
docker compose -f compose.yaml -f compose.sandbox.yaml up --build -d
```

On Docker Desktop, use the socket's group **inside the Docker VM**, not the macOS
host group. You can inspect it with
`docker run --rm -v /var/run/docker.sock:/var/run/docker.sock node:22-bookworm-slim stat -c '%g' /var/run/docker.sock`.
`DATOOL_DOCKER_SOCKET` can select a nonstandard host socket path.

**Access to the Docker socket grants control of the Docker host.** This opt-in
is an operator trust decision, not a security boundary against an app-server
compromise. Prefer a separate sandbox host/provider for a public multi-user
installation. The default Compose file mounts no socket and grants no extra
privileges. Keep **Local container** selected for projects using this override.
Pull both scorer images on that daemon before testing: scorer execution uses
`--pull=never`. Local containers have no network, a read-only root filesystem,
no Linux capabilities, an unprivileged user, and CPU, memory, process, and time
limits. Do not remove those limits to make a failing scorer pass.

## Optional CMS

Set `DATOOL_CMS_ENABLED=true` and generate an independent `PAYLOAD_SECRET` of at
least 32 characters. Run migrations and restart with the new settings:

```sh
docker compose run --rm migrate
docker compose up -d
# Preview the seed before applying it to the named database:
docker compose exec app bun run cms:seed --database datool
docker compose exec app bun run cms:seed --database datool --apply
```

Set `CMS_ADMIN_USER_IDS` to the Better Auth user IDs allowed to edit content.
An empty list grants no editing access. CMS data lives in the separate `payload`
schema; optionally set `PAYLOAD_DATABASE_URL` to use a separate database.
The seed supplies the initial marketing content and preserves existing drafts.

When the flag is unset or false, `/` sends anonymous visitors to `/sign-in`;
CMS admin/API, preview, marketing, pricing, and CMS Markdown routes are disabled.
`/docs` remains available. Release skips CMS migrations, so no CMS secret or
schema is required. Turning the flag off preserves previously saved CMS data.

**Existing installations using the marketing site must explicitly set
`DATOOL_CMS_ENABLED=true` before upgrading**, including the hosted Datool site.
This is runtime configuration; it does not require a different image.

## Acceptance checks

```sh
bun run test:self-hosting
```

This builds the production image and uses a disposable Compose project with
fresh volumes. It exercises the real magic-link/session path with a local mail
transport fixture, first organization/project creation, project API keys,
SDK ingestion through the worker, sandbox execution, and persistence after
restart. It also checks the CMS-off routes without a CMS secret/schema. The
fixture captures emails locally and never contacts Resend; live email delivery
and a real Google login still need operator verification with your credentials.
The optional Docker sandbox override is enabled only for this disposable test.

The existing `bash scripts/test-docker.sh` separately exercises the opt-in CMS,
migrations, repeatable seed, published content, and the unavailable-sandbox path.
Neither acceptance command uses host application env files or a production
database. Generated evidence belongs in ignored local artifacts, not Git.
