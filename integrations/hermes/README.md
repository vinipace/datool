# Hermes → Datool

A native Hermes plugin that automatically sends conversation turns, model requests and tools to Datool. No instrumentation in the client's agent, Node.js sidecar, Python dependencies or Datool server changes are needed.

Requires **Hermes 0.21.3 or later**. Verified against release `v2026.9.14`, commit `345cd2b057a452236de401d3534b8502a7465e8d`. Other versions/providers/platforms need their own verification.

## Install on the machine running Hermes

1. In Datool, create an API key with **traces:write** and copy the target project ID. Use the client’s own project.
2. Download the `datool-hermes-<version>.zip` asset from a `hermes-v<version>` [GitHub Release](https://github.com/vinipace/datool/releases), extract it, and open the `datool-hermes` folder (or use this directory in a Datool checkout), then run:

   ```sh
   python3 install.py
   ```

   In the Datool checkout, use `python3 integrations/hermes/install.py` instead. The installer prompts for the Datool origin, project ID and API key, copies the plugin to `~/.hermes/plugins/datool`, verifies the authenticated connection, saves credentials privately, and enables it through Hermes. The key is entered invisibly and stays out of command history. The plugin does not require permission to replace tools.
3. Restart Hermes, including a running gateway, and use it normally. Open **Traces** in the selected Datool project.

For another profile or executable:

```sh
python3 install.py --home /path/to/hermes-profile --hermes /path/to/hermes
```

For automated installation, provide `DATOOL_BASE_URL`, `DATOOL_PROJECT_ID` and `DATOOL_API_KEY` through the environment. Remote Datool origins must use HTTPS; loopback HTTP works for local development. Each Hermes profile must enable the plugin. Future runs are captured; this does not backfill old history.

## Inspect and retry

Model spans recognize Hermes's request and response envelopes and open in Datool's **LLM** conversation view. **JSON** and the span's **Raw** tab retain the full captured payload, including model settings and usage. Existing saved traces use the same renderer; no backfill is needed.

```sh
hermes datool status
hermes datool flush --timeout 60
hermes datool configure
```

`status` reports pending events and PostgreSQL-confirmed saved events. `flush` exits unsuccessfully if delivery is incomplete. To disable tracing, run `hermes plugins disable datool` and restart Hermes. Configuration and the pending outbox remain on disk so disabling does not erase unsent traces.

Credentials and the durable SQLite outbox live in `$HERMES_HOME/datool` (default `~/.hermes/datool`). `DATOOL_HERMES_STATE_DIR` overrides this directory. The directory is private; the configuration and database files have mode 0600. Do not share this directory. Only upload source files when distributing the plugin.

The outbox binds to one origin/project. To change destinations, first flush the old outbox, then use a new `DATOOL_HERMES_STATE_DIR`; the connector refuses to move pending private traces into another project. API keys can be rotated for the same destination with `configure`.

## What is recorded

- One Datool session per Hermes session; one trace and agent span per turn.
- Each model request/response exposed by native hooks, model/provider, timestamps, finish reason, API errors and retries.
- Exact normalized input/output, cached, cache-write and reasoning counters when Hermes supplies usage. Hermes’s uncached input counter is converted into Datool’s inclusive input counter. Missing usage and cost remain unavailable.
- Tool inputs, results, failures/cancellations and timing. Concurrent calls correlate by tool-call ID. Tools link to their producing request through `hermes.api_request_id` and share the agent parent.
- Final answers and turn completion/error/cancellation, plus platform and parent session IDs when Hermes emits them.

Prompts and tool content are captured by default. API-key/authorization fields and the configured Datool/OpenAI key values are redacted. This is not a general PII scrubber. To omit content, set `DATOOL_HERMES_CAPTURE_CONTENT=false` before starting Hermes, or set `capture_content` to `false` in the private `config.json`.

Hermes sanitizes and can truncate model-hook payloads; the plugin retains these markers and labels model spans accordingly. These are the request/response representations exposed by Hermes, not a guarantee of complete provider wire payloads. Internal detached background work that does not emit session/turn hooks is outside this connector’s coverage. Cross-process subagents retain source session IDs; a single nested cross-process trace is not reconstructed. A force-killed process can leave a started trace running; unsent journaled events still replay on restart.

## Delivery contract

Hooks synchronously journal events with SQLite `synchronous=FULL`; HTTP runs in a background thread. Stable IDs and predecessor chains use Datool’s existing authenticated `/api/ingest` protocol. Events stay pending until `/api/ingest?eventId=…` reports **saved**, after the PostgreSQL transaction commits. Queued/HTTP 202 is not considered saved.

After a connection failure or process restart, the same event IDs and payloads replay. Datool’s receipt deduplication prevents duplicate records. Once saved, content is removed from the local outbox; ID bookkeeping remains. A failed event stays visible and blocks delivery until its cause (credential, worker, project limit or invalid payload) is resolved. There is no silent drop or automatic truncation. Disk failures are logged and must be corrected; telemetry cannot survive a failed local write. Datool payload limits still apply.

The plugin has no recurring daemon outside Hermes. A bounded shutdown flush runs on normal process exit; later Hermes starts or `hermes datool flush` drain pending events. Datool self-hosting needs the normal Redis ingestion worker.

## Repeat the real end-to-end test

Install Hermes in an isolated Python environment and use its Python to run:

```sh
DATOOL_BASE_URL=http://localhost:3000 \
DATOOL_PROJECT_ID=your-local-project \
python scripts/verify-hermes-traces.py --env-file .env.local
```

Provide `DATOOL_API_KEY` and `OPENAI_API_KEY` through the environment or the private env file. The Datool key needs both `traces:read` and `traces:write`. This test makes paid OpenAI calls. It defaults to `gpt-6-luna` with reasoning disabled for Chat Completions tool support; `--model` selects another compatible model.

The test installs/enables the plugin in a fresh Hermes home, runs the real agent against OpenAI, intentionally exits a terminal command with code 7, recovers by writing `42` to a real file, and runs a second turn in the same conversation. It reads the saved Datool traces, checks tool failure/recovery and model request/response capture, reconciles all token counters with Hermes’s cumulative totals, and proves a restart does not duplicate saved traces. Private evidence is written to `.data/hermes-e2e/<run>/verification.json` and `traces.json`.

Regression tests:

```sh
python3 -m unittest discover -s tests/hermes -v
bun test tests/hermes-value-messages.test.ts tests/trace-output.test.ts tests/value-views.test.ts
```

Source contract: [Hermes plugin guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins.md), [Hermes lifecycle hooks](https://github.com/NousResearch/hermes-agent/blob/v2026.9.14/hermes_cli/plugins.py).

## Publish a plugin release (maintainers)

The source stays in this repository. Clients download a standalone ZIP; they do
not need the Datool application checkout or its Node dependencies. GitHub releases
are accessible anonymously once this repository is public. Private-repository
releases require repository access.

1. Set the stable `x.y.z` version in `plugin.yaml`, update `RELEASE_NOTES.md`, and
   merge the changes into `main`. CircleCI's **hermes-verify** job tests the
   connector and extracted installer and packages a preview on branch pushes and
   main. It needs Python only, with no database, provider key, or npm install.
2. In CircleCI, trigger a pipeline on **main** with **operation=publish-hermes**
   and **release-version=0.1.0** (or the new manifest version). This explicit
   action runs only the Hermes verification and publication jobs. Ordinary
   pushes and tag pushes do not publish a plugin release or start this workflow.
3. Verification builds the ZIP and `.zip.sha256` checksum without credentials.
   The publisher requires the same pipeline commit and artifacts, checks main
   ancestry, and reproduces the archive byte for byte before uploading. It
   creates the matching `hermes-v<version>` tag at that commit, or checks an
   existing tag identifies the same commit. It uploads a draft, downloads and
   compares both assets, then publishes and verifies the final downloads.
   Plugin releases do not change the repository's global **Latest** release.
   An existing release is not overwritten; use a new version for changed code.
4. Confirm the workflow succeeded, download the release asset, install it in a
   clean Hermes profile, and verify a new trace in the intended Datool project.
   Publishing this plugin does not deploy Datool's conversation/session UI.

Configure the `datool-hermes` context before the first publication, following
[CI credentials](../../docs/ci.md#activation-and-credentials). It contains a
fine-grained GitHub token named `GH_TOKEN`, limited to this repository with
**Contents: read and write**. Restrict the context to this CircleCI project and
`pipeline.git.branch == "main" and not job.ssh.enabled`. Never place this token
in project-wide variables or the verification job. Choose a token expiry and
rotate it before it expires.

If upload or download verification fails after draft creation, inspect the draft
and failed job before retrying. The workflow deliberately refuses to overwrite
an existing release, including a draft; a maintainer must resolve the failed
draft explicitly. It never moves or replaces an existing tag.

Build the same assets locally without publishing:

```sh
python3 -m unittest discover -s tests/hermes -v
python3 scripts/package-hermes-plugin.py --tag hermes-v0.1.0 --output-dir dist/hermes
```

The packager reads the manifest version and includes only `__init__.py`,
`plugin.yaml`, `install.py`, and this README. ZIP timestamps and permissions are
normalized. Verify a downloaded checksum from the asset directory with
`shasum -a 256 -c datool-hermes-0.1.0.zip.sha256` (macOS) or
`sha256sum --check datool-hermes-0.1.0.zip.sha256` (Linux).

The release does not depend on GitHub Actions runners. Never upload a Hermes
profile, credentials, runtime, or SQLite outbox as an asset.
