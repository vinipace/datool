# Deploying Datool with Dokku

For production image retention, disk preflight, scheduled capacity checks, and
host log rotation, see [disk maintenance](../ops/dokku-disk/README.md).

CircleCI builds and tests the root Dockerfile without database access or
build-time credentials, then transfers that exact image to Dokku. Do not compile
the application on the production host. The runtime runs as `node` (UID/GID 1000), with Node 22
for Next and evaluator isolation and Bun for TypeScript jobs. Dependencies are
not pruned because several runtime UI packages currently live in devDependencies.
The image build sets a 4 GiB Node heap limit for Next.js and its TypeScript worker.
This applies only to the build command; the web and worker runtime processes
retain Node's default memory settings. TypeScript validation remains enabled.

`Procfile` runs migrations in Dokku's release phase, before replacing running
containers. `app.json` starts one web process and one ingestion worker. Keep one
web process while app connections and playgrounds use local JSON storage: those
writers do not coordinate between processes, including overlapping deployments.
Avoid editing that state during deployment. PostgreSQL stores traces and receipts.

The pre-release migration history is consolidated into `migrations/0001_initial.sql`
for fresh databases. The runner records it once in `schema_migration`; subsequent
deployments skip it. Future schema changes must use new numbered migrations.
Disposable databases created with the former migration history should be recreated
before testing this baseline; this is not an upgrade path for that old history.

## Configure before the first push

Create the Dokku app, configure its domain/TLS, and link PostgreSQL and Redis (or
set their connection URLs). Set these runtime variables with `dokku config:set`:

- `DATABASE_URL`: PostgreSQL connection URL.
- `DATOOL_ALERT_DATABASE_URL`: dedicated restricted alert reader login. After the
  alert migrations, provision it with `bun run db:alerts-reader` using an
  administrator connection, then configure workers and restart them. See
  [alert reader setup and limits](./alerts.md#runtime-and-delivery). Missing or
  unsafe credentials disable evaluations with a visible rule error.
- `REDIS_URL`: Redis connection URL shared by web and worker. Use persistent Redis
  with AOF enabled and `maxmemory-policy noeviction`.
- `BETTER_AUTH_URL`: exact public HTTPS origin.
- `BETTER_AUTH_SECRET`: unique random secret, at least 32 characters.
- `DATOOL_CMS_ENABLED=true`: explicitly enable the CMS and marketing site.
  Existing hosted installations must set this before upgrading. It defaults to false.
- `PAYLOAD_SECRET`: stable random CMS secret (`openssl rand -hex 32`). Required
  only when the CMS is enabled; otherwise the release skips CMS migrations.
- `CMS_ADMIN_USER_IDS`: comma-separated existing Better Auth user IDs allowed
  to edit the CMS. An empty list denies editor access. CMS tables use the
  `payload` schema in `DATABASE_URL`, unless `PAYLOAD_DATABASE_URL` is set.
  See [CMS setup and first-time seeding](./payload-cms.md#production-bootstrap).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: enable Google login. Register
  `<BETTER_AUTH_URL>/api/auth/callback/google` with Google.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`: enable passwordless email sign-in links
  using a sender verified in Resend. Links expire after 10 minutes.
- `AUTH_ALLOWED_DOMAINS`: comma-separated exact email domains allowed to sign in
  with either method. Empty denies new sign-ins; passwords remain disabled.

Mount persistent storage at `/app/.data`. For Dokku's docker-local scheduler, run
on the server (replace `datool` if using a different app name):

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/dokku/data/storage/datool
dokku storage:mount datool /var/lib/dokku/data/storage/datool:/app/.data
dokku ps:set datool restart-policy unless-stopped
```

Port 3000 is exposed for Dokku's proxy; TLS terminates at the proxy. Back up
PostgreSQL and the data directory. Never mount a developer `.env.local` or `.data`
directory. Image builds deliberately exclude both. Do not scale `release`;
`app.json` manages web/worker quantities instead of `ps:scale`.

After pushing the committed release to Dokku, check `dokku ps:report datool`,
`dokku logs datool -p worker`, and `dokku run datool bun run ingestion:jobs status`.
Verify Google login and a small SDK trace on the real domain before routing
production traffic. The image test does not authenticate with Google or deploy
to an actual Dokku host.

## Repeatable local image test

```sh
bash scripts/test-docker.sh
```

Requires Docker and OpenSSL. Builds `datool:dokku-test`, creates an isolated
network, fresh PostgreSQL/Redis containers, and a disposable data volume. No host
ports or application env files are used. Tests migrations twice, HTTPS access
checks, v1 API/evaluator behavior, actual SDK delivery through a separate worker
into PostgreSQL, non-root execution, and persistence across restart. Temporary
containers/network/volume are removed even on failure; the built image remains.

For an already built image: `DATOOL_DOCKER_SKIP_BUILD=1 bash scripts/test-docker.sh`.

Validated locally on 2026-09-10 with Linux ARM64 containers: the complete command
above passed, including the production build and all listed image acceptance
checks. This does not establish deployment success on the target Dokku host or
verify Google OAuth credentials. No production services were contacted.

References: [Dokku release tasks](https://dokku.com/docs/advanced-usage/deployment-tasks/),
[process formation](https://dokku.com/docs/processes/process-management/), and
[persistent storage](https://dokku.com/docs/advanced-usage/persistent-storage/).

## CircleCI deployment

The `ci` workflow in `.circleci/config.yml` deploys pushes to `main` and default
manual pipelines on `main` to the host configured by `DOKKU_SSH_HOST`. Deployments use a serial
group and the restricted `datool-production` context. Both package verification
and image verification must succeed before deployment. The verification job builds the image on the CI runner,
exercises it with isolated PostgreSQL and Redis, and uploads a checksummed archive
with a unique commit/pipeline/build tag. The deployment job imports that archive with
`disk:load-image`; the disk preflight runs before Dokku wraps the existing image, runs release migrations, and
replaces the web and worker containers. It does not run `bun install`, Next.js
compilation, or TypeScript checking on the production host.

The image contains `/app/Procfile` and `/app/app.json`, preserving migrations and
the web/worker formation. The image revision label records the source commit.
The archive is passed through a CircleCI workflow workspace; no container
registry or registry credentials are required. Workspace retention follows the
CircleCI organization settings. Rerunning only a failed deploy reuses the
verified artifact and its recorded tag. Once the artifact expires, rerun the
whole workflow to rebuild and verify it.

Do not manually push application source to the Dokku Git receiver. That path
builds on the live host and can starve the app and databases. Keep host inventories,
maintainer accounts, SSH fingerprints, recovery-console links, and incident
records in a private operator runbook. Never commit private keys or raw logs.

Context variables `DOKKU_NETCUP_SSH_PRIVATE_KEY` and
`DOKKU_NETCUP_SSH_KNOWN_HOSTS` provide dedicated restricted deployment access
and pin the verified host key. Set `DOKKU_SSH_HOST` to the SSH hostname or IP
address, without a username, scheme, or port. Both deployment and monitoring
require this variable in their restricted CircleCI contexts; configure it before
enabling or updating these workflows. Context variable `DATOOL_URL` is the public
HTTPS origin. The `datool-deploy` account's forced command permits Datool image
imports and health reports only; see [installation](../ops/dokku-deploy/README.md).
The workflow requires both web and worker running and checks the public routes.
A successful HTTP check alone does not verify Google login or end-to-end ingestion.
The separate `datool-monitor` account and `NETCUP_MONITOR_SSH_*` secrets support
scheduled disk checks without deployment permission.

Use dedicated Dokku PostgreSQL and Redis services, with Redis AOF and
`appendfsync always`. Persist app files at `/app/.data` and do not expose database
ports publicly. Configure DNS and TLS for your own public HTTPS origin, then
register `<BETTER_AUTH_URL>/api/auth/callback/google` in your Google OAuth client.
The application uses `BETTER_AUTH_SECRET`, not `NEXTAUTH_SECRET`; generate a fresh
value when provisioning a new installation. Google credentials stay in Dokku's
runtime configuration and are not stored in CircleCI.
