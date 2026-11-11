# Agent sandboxes and drives

Open **Settings → Sandbox** to enable command execution. Choose
Datool Sandbox, a project-configured Modal account, or Local container. Select
Node.js 22 or Python 3.13, and enable network access when downloads or dependency
installation are needed. The feature is off for existing agents.

Configure the selected provider in **Project settings → Sandbox providers**
before publishing an agent with its sandbox enabled. Drafts can be saved while
setup is incomplete. If a provider becomes unavailable later, file and command
tools report the configuration error in their history; they do not switch to a
different provider or drive.

Open **Build → Sandbox** for the drives table, which includes each drive's ID.
**Add drive** opens a sheet to create a drive. The sheet asks for a name and
description; mount paths are assigned automatically. Expand **Advanced settings**
to override the path, choose a working directory or mount an existing drive.

Mount up to four drives at distinct, non-overlapping paths under `/workspace`. The working directory defaults
to the first mounted drive. For example, mount research at `/workspace/research`
and reports at `/workspace/reports`. Separate drives give agents separate contexts;
agents mounting the same drive share its files across all their conversations.

The model discovers Eve's native `bash`, `read_file`, `write_file`, `edit_file`,
`glob` and `grep` tools. Commands share one environment for the turn. `bash`
accepts `command` and an optional `timeout` (1–120 seconds, default 30); a command
that outlasts that wait returns a process ID and output paths so the agent can
check or stop it with later commands. Background processes end with the turn.
Only files in mounted drives survive environment shutdown and future turns.
Keep dependencies in a native Docker or Modal drive (`node_modules`, virtual environments, or pip's
`--target` directory). Installing a package globally into a temporary environment
does not persist it. Changing the Node/Python environment retains mounted files;
dependencies with native binaries may need rebuilding.

Commands return stdout, stderr, status and an exit code or background process
details. Eve bounds displayed output. Execution is limited to 1 CPU and 512 MiB. Network access starts
disabled. Provider credentials are never injected into the sandbox. Commands are
recorded in the conversation's tool history. When Guardrails requires human
approval for actions, sandbox commands are unavailable. Simulations that mock
external actions also omit this tool so they cannot write production drives.

## Persistence and ownership

The drive catalog is project-scoped. Configuration saves and execution both reject
foreign drives and incompatible native volumes. Native drives remain tied to their provider;
there is no fallback to a different provider with empty storage. Unmounting,
disabling or archiving an agent retains its drive contents. Cloning an agent
retains its drive references and therefore shares the same context.

Local drives use named Docker volumes on the configured daemon. All workers using
them must use that same daemon; moving to a different host requires migrating the
volumes. Pre-pull `node:22-bookworm-slim` and `python:3.13-slim`. Execution uses an
unprivileged container, a read-only root filesystem, dropped capabilities and
temporary writable directories. Only server-generated named volumes are mounted;
there are no caller-selected host paths or daemon socket mounts in agent containers.

Datool Sandbox and Modal use named Modal Volumes. Sandbox termination waits for the
provider's final commit before returning success; see [Modal filesystem persistence](https://modal.com/docs/guide/sandbox-files).
Once a volume has been provisioned, a missing volume fails rather than silently
creating replacement storage. Changing credentials to a different provider account
therefore cannot turn an existing drive into an empty one. S3 and GCS drives can instead persist independently of compute. See
[Agent drive storage](agent-drive-storage.md) for setup, direct SDK file access,
version history, export/import and recovery. Drive deletion and in-place SDK
storage migration are not included.

Drive writers acquire durable leases before creating an environment. Another turn
using the same drive returns a busy result. Commands within a turn reuse its lease.
Leases release after confirmed shutdown; an unknown outcome retains the lease for
twelve minutes, longer than the environment's ten-minute maximum lifetime.
Datool Sandbox reserves execution credits and settles observed
allocation at the 1 CPU / 512 MiB rate; Modal and Local use the project's infrastructure.
Persistent storage is retained separately from sandbox compute usage.

## API and rollout

`build_create_drive` takes `name`, `description` and `provider`; it requires
`build:write` and an idempotency key. `build_list_drives` requires `build:read` and
supports `after`/`limit` pagination. Configure mounts through `build_update_agent`
using its ordinary revision and draft/apply controls. The authoring guide publishes
the complete sandbox configuration schema.

Apply `0079_build_drives.sql`, `0084_build_agent_sandboxes.sql` and `0088_drive_storage.sql` with the normal database migration flow before
deploying code. No existing agent opts in automatically.

Verification:

```sh
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> bun --no-env-file test tests/build-sandbox-drives.test.ts
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> DATOOL_TEST_SANDBOX_CONTAINERS=1 bun --no-env-file test tests/build-sandbox-drives.test.ts
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> DATOOL_TEST_SANDBOX_CONTAINERS=1 bun --no-env-file test tests/build-eve-native-tools.test.ts
```
