# Codex traces

The local connector combines Codex's OTLP/HTTP telemetry with its saved conversation. It imports one Datool session per Codex thread and one trace per user turn. Each trace contains sampling steps, individual model calls, tool arguments/results, failures, and the final answer.

## Run a traced Codex task

Create an API key with `traces:write` in Datool Project settings. Put the destination in an ignored environment file (for example `.env.codex.local`):

```dotenv
DATOOL_BASE_URL=http://localhost:3000
DATOOL_PROJECT_ID=your-project-id
DATOOL_API_KEY=your-key
```

Start Datool normally. Then, from this repository:

```sh
bun --env-file=.env.codex.local scripts/codex-traces.ts run -- \
  --sandbox workspace-write -C /path/to/your/repo "Your task"
```

Everything after `--` is passed to `codex exec`. The wrapper starts a loopback receiver on a free port, configures telemetry for that child process, waits for Codex's exporter shutdown, enriches the captured turns, and waits for Datool's PostgreSQL commit. It prints a `datool.trace.saved` receipt with the trace and session IDs. No global Codex configuration is changed. Use `CODEX_BIN` to select a different installed Codex executable.

The API key stays in the connector process. Codex only receives a token that grants access to its loopback telemetry receiver. Exported prompts and tool content are enabled because this integration is intended for detailed trace inspection.

## Capture from the desktop app or an interactive CLI

Run the persistent receiver:

```sh
bun --env-file=.env.codex.local scripts/codex-traces.ts serve \
  --port 4318 --state-dir .data/codex --cwd /path/to/your/repo
```

The optional `--cwd` filter limits imports to a matching Codex working directory. The collector writes `.data/codex/otel.config.toml`, with its endpoints, JSON protocol, and receiver token. Merge that file's `[otel]` settings into your Codex configuration, preserving any unrelated settings, then restart the Codex client. The receiver must remain running. The connector uses the same `CODEX_HOME` and `CODEX_BIN` as the client whose history it reads.

The receiver implements **OTLP/HTTP JSON** at `/v1/logs` and `/v1/traces`. Set `protocol = "json"`; protobuf and gRPC are not implemented. It binds only to `127.0.0.1`, authenticates requests with its generated token, rejects browser-origin requests, and limits batches to 32 MiB. This is a Codex adapter, not a general-purpose OTLP collector.

Completed turns are imported on the next sync, normally within three seconds of receiving the terminal turn span. Codex controls when batches are exported; active turns do not yet appear as live traces. The App Server reader never resumes, mutates, or executes a stored task. The desktop client's emission behavior must be validated with that client's installed build; the automated E2E proof uses the installed CLI.

## What the trace retains

- User input, final answer, conversation items, commands, stdout, exit codes, file changes and MCP/dynamic tool results when present in the saved history.
- Individual model attempts and exact input/output, cache-read, cache-write and reasoning token counters emitted by Codex.
- Source timestamps, original OpenTelemetry IDs, explicit parent relationships, source error status, and time-to-first-token when emitted.
- Recorded model context and response items when the App Server identifies an accessible JSONL history. This is **recorded context**, not a claim to reproduce the provider's exact wire request: internal system prompts, tool schemas, compaction and provider transformations may differ. Coverage attributes distinguish this from the App Server-only fallback.
- Exported reasoning summaries only. Encrypted reasoning blocks are omitted.

Warm-up calls and inclusive turn/step totals are excluded from the sum of model usage. `codex.usage.reconciliation` compares the resulting input/output/cache-read totals against Codex's own turn counters. A mismatch marks coverage partial. Missing counters and model pricing stay unavailable, never zero. Prices, when available in Datool's bundled TokenLens catalog, are API-rate estimates and do not represent a Codex subscription charge.

Internal implementation spans remain in the local raw journal. Datool shows meaningful sampling and tool spans. A tool emitted on a separate OTel trace can be assigned to a unique enclosing sampling interval; this is labeled `unique_sampling_interval`. The connector does not invent a nested code-mode parent when Codex omits the cross-trace link. Tool output truncation flags and unavailable timestamps remain explicit.

## Delivery, replay and limits

The collector writes each raw batch to a private, synced journal before acknowledging it. Pending snapshots are also saved locally before upload. Run one collector per state directory. Raw captures and the receiver token are under `.data/codex` by default, ignored by Git, with private directory/file permissions. Keep that directory to retry a failed upload; protect it like conversation history. There is no automatic retention policy yet.

Datool's authenticated `POST /api/ingest/codex` requires `traces:write` and commits each snapshot atomically. Deterministic IDs include the project, Codex thread and turn. Repeated requests do not duplicate sessions, traces or spans. Older snapshots cannot overwrite newer snapshots or reopen completed turns. History-only or incomplete captures cannot replace richer recorded telemetry. This endpoint writes PostgreSQL synchronously; it does not use the generic SDK's Redis lifecycle queue. HTTP 200 means the transaction committed.

Snapshots are limited to 16 MiB and 1,000 semantic spans per turn. Larger snapshots fail explicitly and stay in the outbox; content is not silently truncated. The optional JSONL fidelity reader falls back to App Server items when a history file is unavailable, unrecognized, or larger than 256 MiB. Modern App Server turn pagination is required; verified with Codex CLI 0.154.0.

Restart `serve` with the same state directory to retry pending deliveries. A state directory is bound to one Datool origin/project to avoid accidentally replaying private traces into another project. To enrich or retry one specific stored thread:

```sh
bun --env-file=.env.codex.local scripts/codex-traces.ts import --thread THREAD_ID
```

Without its captured OTLP batches, a historical import has conversation/tool history but marks missing model usage and precise tool timing as unavailable. For maximum fidelity, enable capture before the run.

## Repeat the real local E2E proof

Use a local project and a key with both `traces:write` and `traces:read`:

```sh
bun --env-file=.env.codex.local scripts/verify-codex-traces.ts
```

The test runs the installed Codex with its existing login in a temporary workspace. It deliberately executes a command that exits with code 7, recovers, calculates a sum from a real input file, and writes a result file. It reads the persisted Datool trace over authenticated HTTP and asserts the final answer, failure and recovery, model context/responses, and exact equality with Codex's own usage totals. It resumes the same conversation for a second real turn, checks that both traces share a session and their usage sums match Codex's cumulative totals, then restarts the connector and proves unchanged history is not reuploaded. The private capture directory includes `verification.json`, CLI events, the raw telemetry journal and delivery receipts.

Regression tests cover realistic telemetry fixtures, retries/reordering, missing usage, tool failures, hierarchy validation, authentication and destination binding. The persistence test uses a disposable schema via `DATOOL_TEST_DATABASE_URL`:

```sh
bun test tests/codex-traces.test.ts tests/codex-collector.test.ts
DATOOL_TEST_DATABASE_URL=postgresql://... bun test tests/codex-traces-persistence.test.ts
```

Sources: [OpenAI telemetry configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
