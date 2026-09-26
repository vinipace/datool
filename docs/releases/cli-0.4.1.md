# CLI 0.4.1: safe connected-app reloads

`@datool/cli@0.4.1` fixes queued calls failing with `Local bridge disconnected.`
when a watched handler reloads. This is a CLI-only release following 0.4.0;
do not republish the SDK.

- Keep the relay mailbox online during reload; finish started calls, telemetry
  flushes, and result acknowledgments before transferring it to a fresh worker.
- Preserve queued calls, arriving calls, call IDs, and deadlines across source
  edits. Rotate session tokens and serialize enqueue, exchange, handoff, and
  disconnect in one database transaction to fence delayed requests.
- Never transfer claimed, unresolved work. Lost exchange and registration
  responses retry without replaying handlers. Incompatible queued definitions
  fail explicitly before execution.
- Keep queued calls compatible across code-only edits while recording the new
  code provenance and app revision. Preserve protocol 2 receipts and late results
  so uncertain delivery remains recoverable.
- Ignore generated JSON under `tmp`, `temp`, `artifacts`, `test-results`, and
  `playwright-report`, in addition to existing build/dependency exclusions.
  Source imports and ordinary JSON/YAML configuration still reload. A periodic
  snapshot catches missed filesystem events under Node and Bun.

Deploy the matching hosted relay (bridge protocol 2 and `session-v1`) before
upgrading watched clients. Apply the existing migrations from `main`, including
the protocol 2 exchange receipt ledger; this reload change adds no migration.
Older CLI versions retain their existing behavior. `--no-watch` requires bridge
protocol 2 but does not require `session-v1`.

```sh
npm install --save-dev @datool/cli@0.4.1
# Bun projects:
bun add --dev @datool/cli@0.4.1
```

Regression coverage uses the real PostgreSQL relay with 16 active and five queued
or arriving calls, delayed telemetry, lost acknowledgments, token fencing,
concurrent enqueue/disconnect/resume, definition changes, and expired deadlines.
CI runs the built CLI with both Node and Bun; package verification also covers
Node 22.18 and 24 and clean tarball installations.
