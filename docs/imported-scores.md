# Imported scores

Datool can store external scores without inventing a Datool evaluator or evaluation execution. This is the persistence API for import adapters; it does not fetch data from external providers itself.

## API

Use the normal project authentication and `x-project-id` header:

- `POST /api/imported-scores` requires `evals:write` and accepts one record.
- `GET /api/imported-scores` requires `evals:read` and returns paginated import outcomes. Pass `cursor` for the next page.
- `GET /api/imported-scores?id=<import-id>` returns the original payload and current outcome.

Example request:

```json
{
  "source": {
    "provider": "external-evaluator",
    "instance": "https://scores.example.com",
    "projectId": "source-project-id",
    "id": "source-score-id"
  },
  "record": {
    "name": "Quality",
    "timestamp": "2025-05-01T12:00:00Z",
    "target": { "type": "trace", "id": "destination-trace-id" },
    "data": { "type": "numeric", "value": 8.5 },
    "comment": "Original assessment",
    "author": { "id": "source-reviewer-id" },
    "metadata": { "environment": "production", "source": "ANNOTATION" },
    "raw": { "original": "provider record goes here" }
  }
}
```

`source` identifies the external record. Adapters must use a stable instance identifier, including the same URL spelling on retries. `target.id` is the **destination Datool ID**: resolve source-to-destination IDs before submitting a supported record. Supported target types are `trace`, `span`, `session`, and `evalRun`. Span targets resolve to their parent trace without losing the span ID.

Supported values are finite `numeric` values (without a 0–1 restriction), actual `boolean` values, `categorical` strings, and `text` strings. No implicit value conversion occurs. Adapters must explicitly map provider types, preserve provider fields and source relationships in `raw`, and retain unavailable or unsupported records rather than omitting them.

The complete `record` JSON is archived, including unknown fields. Supported fields are also normalized into `scores.external_json`; the original timestamp becomes the score's `created_at`. Original authors remain external provenance rather than being assigned a Datool user identity.

## Outcomes and retries

Responses use the normal `{ "data": ... }` envelope and include `id`, `status`, `reason`, and `scoreId`:

- `imported`: a native score was persisted, with the correct target and typed value.
- `unsupported`: the original JSON was saved, but its shape, value type, timestamp, or target kind cannot be normalized. `reason` identifies the validation issue.
- `unresolved`: a supported record was saved but its target is unavailable in this project. Import the target and submit the same record again.

An HTTP 200 response alone does not mean the score was imported. Callers must inspect `status` and reconcile every submitted source record. Malformed envelopes without a source identity or JSON record are rejected with HTTP 400; callers must retain rejected inputs themselves.

Identity includes the destination project and the source provider, instance, project, and score ID. Concurrent retries with the same JSON content create one score. JSON object key order is ignored. A different payload for an existing source identity returns HTTP 409 and preserves the original; source updates need an explicit future revision policy. Imports are transactional, so a database failure does not leave a success receipt without its score.

Deleting a target cascades to its normalized score but retains the import record. Reads report `unresolved` when the score is missing. Retrying can recreate it after the target is restored. Deleting the project removes both the score and its archived import record.

## Read and analytics behavior

Trace and span scores appear in trace score reads, with their source and target under `external`. Values use literal `valueLabel` text, so a numeric score of 8.5 is not displayed as 850%. Session and run targets are preserved and retrievable through the import API; dedicated session/run score UI is not included.

Existing `scores.*` semantic metrics describe Datool evaluation executions. External scores do not manufacture `eval_results`, so they do not affect those metrics. Native evaluation writes and their evaluator/result foreign keys remain enforced. Imported scores keep both fields null and require import provenance and a valid project-scoped target.

The database change is migration `0018_imported_scores.sql`.
