# Local Langfuse imports

This backend imports sessions, traces, observations (including generations and events), and scores into an **existing local Datool project**. It provides a command and a Redis worker. It does not include a UI, datasets, prompts, experiment history, or media-file downloads.

## Setup

Use local PostgreSQL and Redis, and create a destination project through Datool first. The command requires loopback database/Redis hosts and does not create projects or apply migrations automatically.

```sh
cp scripts/langfuse-import.env.example .env.langfuse-import.local
```

Fill the five variables in that ignored file:

- `DATABASE_URL`: local Datool PostgreSQL connection.
- `REDIS_URL`: local Redis connection.
- `LANGFUSE_BASE_URL`: your source instance's base URL, without `/api/public` (`LANGFUSE_HOST` is also accepted).
- `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`: source project keys.

Apply the pending migrations to the local database, including `0018_imported_scores.sql` and `0019_langfuse_imports.sql`:

```sh
bun --env-file=.env.langfuse-import.local run db:migrate
```

Start the worker in a separate terminal:

```sh
bun --env-file=.env.langfuse-import.local run worker:imports
```

The worker only makes GET requests to Langfuse. It verifies that the source project associated with its keys matches the run before processing it. Credentials stay in the environment; Redis jobs contain only the destination project ID and import run ID. Redirects are disabled. Error logs and saved error codes exclude response bodies, keys, and connection strings.

## Start with a small window

Replace `DESTINATION_PROJECT_ID` and the dates:

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse start \
  --project DESTINATION_PROJECT_ID \
  --from 2026-09-01T00:00:00Z \
  --to 2026-09-02T00:00:00Z \
  --page-size 50
```

The command verifies the Langfuse connection and prints a durable `runId` before queueing. If Redis is unavailable, keep that ID and use `resume` after Redis recovers.

`--page-size` accepts 1–100. Lower it if a source page exceeds the 32 MiB response limit. The default end time is fixed at 15 minutes before run creation to account for delayed source visibility. An explicit `--to` overrides it.

After verifying a small sample, start the history import:

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse start \
  --project DESTINATION_PROJECT_ID --all
```

`--all` starts at the Unix epoch. Each resource is selected by its own source timestamp: sessions by creation time, traces/scores by timestamp, observations by start time. A window can exclude a score's trace or a span's parent. Those records remain archived and are reported as unresolved; this command does not silently expand the selected date range. A full source-history import can resolve dependencies, followed by `resume` on the narrower run.

## Progress, issues, and resume

### Repair analytical mappings on existing imports

The importer maps explicit function IDs from Langfuse metadata, cache/reasoning token aliases, and recorded cost components. Input/output totals exported by Langfuse already include their subcategories; flat `usageDetails` buckets are exclusive. Reasoning cost is included in output cost, and cache costs remain separate. Original records and total cost are preserved; no provider prices are inferred.

For earlier imports, run the separate backfill against the local destination:

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse backfill --project DESTINATION_PROJECT_ID --dry-run
bun --env-file=.env.langfuse-import.local run import:langfuse backfill --project DESTINATION_PROJECT_ID
```

This uses the immutable local observation archive; it needs no Langfuse credentials or Redis worker. It fills missing analytical attributes in batches, merges missing cost components, and preserves conflicting existing values while reporting their record count. It does not change source archives, input/output token totals, total costs, record IDs, or timestamps. Repeating it makes no further changes. `changed` in a dry run means records that would change.

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse status \
  --project DESTINATION_PROJECT_ID --run RUN_ID

bun --env-file=.env.langfuse-import.local run import:langfuse resume \
  --project DESTINATION_PROJECT_ID --run RUN_ID
```

Status includes the checkpoint, selected API modes, counts by resource/outcome, fetched page totals, warnings, and the first 50 record issues. Terminal states:

- `completed`: all fetched records were imported and no completeness warning was detected.
- `completed_with_issues`: processing ended with unsupported, unresolved, conflicting records, source count mismatches, or unavailable original container APIs. This is **not** a complete migration.
- `failed`: inspect the safe `errorCode`; fix the configuration/service problem and resume. Transient failures also receive up to 12 queue attempts with a 60-second backoff. Longer provider `Retry-After` values delay the job accordingly.

A worker restart resumes from the last saved page or pending materialization record. Fetching each page and advancing its checkpoint is one database transaction. Creating a native entity and marking its source record imported is another transaction. A per-run PostgreSQL lock prevents concurrent processors. A source-object lock and stable IDs prevent duplicates across overlapping runs.

List all issues for a resource, using the returned `nextCursor` as `--after` for the next page:

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse issues \
  --project DESTINATION_PROJECT_ID --run RUN_ID --kind observations
```

Inspect a complete archived record explicitly:

```sh
bun --env-file=.env.langfuse-import.local run import:langfuse record \
  --project DESTINATION_PROJECT_ID --run RUN_ID \
  --kind observations --source-id SOURCE_OBSERVATION_ID
```

Kinds are `sessions`, `traces`, `observations`, and `scores`. This command prints source payloads and should be used in a private terminal.

## Mapping and completeness

- Original source JSON remains in `langfuse_import_records`, including unsupported fields and records.
- Stable destination IDs include the destination project, source host/project, resource kind, and source ID. Overlapping runs reuse matching snapshots. Changed source records are retained as conflicts and do not overwrite existing Datool data. This is a historical import, not a continuous synchronization service.
- Sessions preserve source timestamps. Missing session containers are reconstructed from observed references and marked `synthetic` in the report.
- Trace inputs, outputs, metadata, tags, and original start timestamps are preserved. End times derive from observed end timestamps; the importer never substitutes the current time. Incomplete observations leave end times unset.
- Observations keep their trace and parent relationships. Children received before parents are retried during materialization. Missing or cyclic parents remain unresolved rather than being silently attached to the trace root.
- Model, usage, and reported cost values are mapped onto observation analytics fields. Trace aggregate costs are preserved as source metadata rather than added again to observation costs. Original usage/cost detail objects remain available. Explicit non-token usage units are preserved as source metadata and are not relabeled as tokens.
- Scores use [the imported-score API model](imported-scores.md). Numeric values keep their scale; legacy boolean 0/1 and categorical strings are explicitly converted. Source authors, comments, metadata, and raw records are retained. Experiment targets and correction types remain archived as unsupported in this first scope.
- The source remains mutable during an export. Fixed time bounds do not create a provider snapshot. Changed duplicate records and differing legacy API totals are reported. Cursor APIs do not supply an independent total; their reports count unique fetched records, not a separately verified source total.

## API compatibility

The connector prefers [Observations API v2](https://langfuse.com/docs/api-and-data-platform/features/observations-api) and [Scores API v3](https://langfuse.com/docs/api-and-data-platform/features/scores-api), requesting all documented field groups used by this importer. It falls back to legacy observations and scores v2 only when the newer endpoint returns 404 or 410. Authentication failures do not trigger fallback.

Where available, legacy trace and session APIs preserve their original records, including empty sessions and traces without observations. If those endpoints return 404/410, the importer reconstructs trace/session containers from observation data and reports `ORIGINAL_TRACES_API_UNAVAILABLE` or `ORIGINAL_SESSIONS_API_UNAVAILABLE`. Original trace-only fields and unreferenced empty sessions cannot be recovered from observation rows. Such runs finish with issues so that the limitation remains visible.

Modern observation I/O strings are parsed as JSON when valid; their original serialized form remains in the archived record. Unknown observation types are retained as unsupported.

## Local validation

`tests/langfuse-import.test.ts` exercises both API layouts against an authenticated simulated source, page checkpoint recovery, rate limiting, project isolation, original-value preservation, reconstruction limitations, conflicting snapshots, and an independent command → Redis → worker → PostgreSQL → status-command round trip.

Run with explicitly disposable loopback services:

```sh
DATOOL_TEST_DATABASE_URL=postgresql://... \
DATOOL_TEST_REDIS_URL=redis://127.0.0.1:... \
bun test tests/langfuse-import.test.ts tests/imported-scores.test.ts tests/tracer-postgres-migration.test.ts
```

A successful simulated-source test does not establish compatibility with a particular live source installation or its data volume. Validate a small source window, inspect counts and sample traces, and resolve reported issues before importing all history.
