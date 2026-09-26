# Scorer sandbox providers

Open **Project settings → Sandbox providers** at
`/p/<projectSlug>/settings/sandbox-providers`. Owners and admins can configure
providers; members can see configuration status and execution order.

Configured providers appear in a table. **Add provider** opens the provider
picker and configuration dialog; each row offers editing, removal and, for a
fallback provider, **Make default**.

Local container is the initial default. Select any configured provider as the
default. The remaining configured providers are fallbacks, in the displayed
order (Local, Vercel, Modal, excluding the default). Removing the default selects
the first remaining provider. Removing all providers prevents code scorers from
running. There is no implicit fallback to a process on the application host.

These settings apply to JavaScript and Python sample tests, recorded-trace
previews, and saved evaluations. LLM scorers continue using model providers.
Provider startup, authentication and transport failures try the next provider.
Scorer results, including zero scores, code errors, protocol errors and execution
limits, stop the fallback chain. Results record `sandboxProvider` and
`sandboxAttempts`, also visible in scorer execution spans.

## Local container

The Datool server needs the Docker CLI, access to its Docker daemon, and these
images pre-pulled:

```sh
docker pull node:22-bookworm-slim
docker pull python:3.13-slim
```

`DATOOL_SANDBOX_DOCKER_BINARY` optionally selects an installed Docker executable.
Datool does not pull images during scoring. Each run uses a new non-root
container with a read-only filesystem, no network, no host mounts, dropped
capabilities, a 128 MiB memory ceiling and a 1 CPU limit. The container receives
only scorer input via stdin and is removed after execution, including failures.
The Datool Docker image includes the CLI. If Datool itself runs in Docker, the
operator must explicitly give its server container access to a dedicated Docker
daemon (for example a socket mount with its matching group). Daemon access is
privileged host access; it is not enabled by the image. The scorer containers
must never receive the daemon socket.
Hosts without Docker, including Vercel Functions, should configure a cloud
provider and remove Local from the fallback order.

## Cloud providers

- **Vercel Sandbox:** provide a Vercel access token, team ID and project ID.
  See [Vercel authentication](https://vercel.com/docs/sandbox/concepts/authentication).
  Runs use an ephemeral sandbox with network access denied and persistence disabled.
- **Modal:** provide the token ID and token secret from the workspace settings.
  Datool creates/reuses the `datool-scorers` app and starts a fresh sandbox for
  each run, with network access blocked. See [Modal's JavaScript SDK](https://modal.com/docs/sdk/js/latest).

Cloud providers receive scorer code and trace evidence. Provider credentials
remain on the Datool server and are never injected into the scorer environment.
Existing worker restrictions and score validation apply to every provider.

Apply migration `0021_project_sandbox_providers.sql` with `bun run db:migrate`.
Credentials use the existing provider encryption key
(`DATOOL_PROVIDER_ENCRYPTION_KEY`, falling back to `BETTER_AUTH_SECRET`) and are
bound to the project and sandbox provider. Read APIs never return credentials.
Replacing a saved key is optional when editing other settings; omitting a secret
preserves it. The server encryption secret must be at least 32 characters.

## Verification

```sh
bun test tests/sandbox-providers.test.ts
DATOOL_TEST_SANDBOX_CONTAINERS=1 bun test tests/sandbox-providers.test.ts
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> bun test tests/sandbox-providers-integration.test.ts
```
