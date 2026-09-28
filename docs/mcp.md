# Datool MCP, Google sign-in, and organization API keys

Datool uses the existing Better Auth PostgreSQL accounts and organization → project hierarchy. Google verifies sign-in; Datool issues MCP tokens. Google access/ID tokens are not Datool API credentials.

`list_scorer_libraries` (scorers:read) discovers curated libraries, exact package/adapter versions, evaluator arguments and model requirements. `create_scorer` and `update_scorer` accept `type: "library"` with a `library` configuration. AutoEvals 0.3.0 supports ExactMatch, Levenshtein, NumericDiff, ValidJSON, JSONDiff and Factuality. Field mappings use trace/datasetItem dotted paths; only Factuality requires a Gateway language model. See the public scorer documentation for the complete JSON example. `use_library_scorer` (scorers:write) takes `{evaluator: "ExactMatch"}` and creates or reuses its project scorer, returning its ID. REST selection is `POST /api/scorers/libraries`; CLI selection is `datool scorers use-library --input '{"evaluator":"ExactMatch"}'`. CLI discovery is `datool scorers libraries`; REST discovery is `GET /api/scorers/libraries` with project authorization.

## Configuration

Required application settings:

```dotenv
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://localhost:3000
```

To enable **Continue with Google**, configure a Google web OAuth client:

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Register the exact redirect URI `<BETTER_AUTH_URL>/api/auth/callback/google` in Google Cloud. For the default local origin this is `http://localhost:3000/api/auth/callback/google`. Passwordless email links are also available when `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set; password sign-in is disabled. Both methods require an email domain in `AUTH_ALLOWED_DOMAINS`. Google credentials are optional for running the app, but Google login is unavailable until both are set. Restart the server after configuration changes.

Run `bun run db:migrate` against the intended application database before starting the updated app. The checked-in migrations add hashed organization keys, OAuth clients/consent/grants/signing keys, and a key-creation policy. Deployment already runs migrations via the existing Vercel build script. Implementation/testing does not itself migrate a deployed database or create a Google Cloud client.

The old `DATOOL_OAUTH_ISSUER`, `DATOOL_OAUTH_JWKS_URL`, `DATOOL_OAUTH_ALLOWED_SUBJECTS`, `DATOOL_MCP_URL`, and `DATOOL_AUTH_ENABLED` draft settings are no longer used. MCP issuer and resource URLs derive from `BETTER_AUTH_URL`.

Optional `DATOOL_MCP_ALLOWED_ORIGINS` is a comma-separated list of exact additional browser MCP client origins. Native clients need none. Use HTTPS outside loopback development.

## Organization API keys

Open **API keys** in the workspace sidebar (`/workspace/<organizationId>/settings/api-keys`). Owners and admins can create and revoke keys and disable new key creation. The policy is enforced by the server, including direct calls to the auth plugin. Existing keys keep working until revoked or expired.

A key belongs to its organization and can access only projects in that organization. It defaults to `traces:write`. Managers can grant explicit additional resource scopes; the creation form lists the supported scopes. Expiry defaults to 90 days and can be set from 1 day to 1 year. Raw keys are shown only once; storage contains a hash and the listing shows a masked preview.

SDK/REST requests provide `Authorization: Bearer <key>` and `x-project-id: <projectId>`. The server verifies the key's permissions and the project's organization before constructing a project-scoped service. API keys do not become browser sessions or authorize membership/key management.

The legacy `DATOOL_API_KEY` + `DATOOL_PROJECT_ID` pair remains a compatibility credential for `traces:write` only. Create an organization key for other permissions. The ingestion status endpoint uses `traces:write` so an ingestion client can wait for its accepted lifecycle event to be persisted.

## Connect an MCP client

Add `<BETTER_AUTH_URL>/api/mcp` as a Streamable HTTP MCP server. The client discovers Datool's authorization server, registers a client, and opens sign-in. After signing in, choose an organization/project and approve the requested scopes.

- Authorization code flow requires S256 PKCE for public clients and exact registered redirects.
- Native local clients should register their loopback redirect as a native application.
- Grants are bound to the selected project and organization. Request headers or tool arguments cannot switch that grant to another project.
- Access tokens expire after five minutes. `offline_access` enables rotating refresh tokens.
- Each MCP request rechecks membership, role, active session, client, and consent. Each refresh rechecks project permissions.
- Revoke a connection at `/workspace/<organizationId>/settings/mcp`. Consent deletion also revokes associated refresh tokens. Other users' consents cannot be removed through this page.
- OAuth client/resource administration is not exposed to ordinary signed-in accounts. Dynamic registration never skips consent or enables machine grants.

Discovery endpoints include `/.well-known/oauth-authorization-server/api/auth`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-protected-resource/api/mcp`.

## Tools and scopes

| Tools                                                          | Required scope     |
| -------------------------------------------------------------- | ------------------ |
| `get_metrics_metadata`, `query_metrics`, `batch_metrics`       | `metrics:read`     |
| `list_scorers`, `get_scorer`                                   | `scorers:read`     |
| `create_scorer`, `update_scorer`, `delete_scorer`              | `scorers:write`    |
| `list_views`, `get_view`, `list_saved_views`, `get_saved_view` | `views:read`       |
| Create/update/delete custom and saved views                    | `views:write`      |
| `list_dashboards`, `get_dashboard`                             | `dashboards:read`  |
| Create/update/delete dashboards                                | `dashboards:write` |
| `list_datasets`, `get_dataset`                                 | `datasets:read`    |
| Create/update/delete datasets and dataset items                | `datasets:write`   |
| `list_review_sessions`, `get_review_session`, `get_review_item`, `get_review_options`, `export_review_items` | `reviews:read` |
| `create_review_session` | `reviews:write`, `traces:read` |
| `update_review_session` | `reviews:write` |
| `record_review` | `reviews:write` |
| `list_human_scores`, `get_human_score`, `get_human_score_collection` | `reviews:read` |
| `create_human_score`, `update_human_score`, `create_human_score_collection`, `update_human_score_collection` | `reviews:write` |

Write scopes do not imply read scopes. Tool discovery and calls enforce the same granted scopes. Dashboard tools manage configuration; semantic tools execute bounded reads. Scorer tools store configurations without executing code or invoking models. Updates/deletes of revisioned resources require `expectedRevision`.

## Query semantic metrics

Call `get_metrics_metadata` with `{}` first. It returns the source-owned catalog of models, measures, dimensions, and supported filters. Then call `query_metrics`:

```json
{
  "query": {
    "measures": ["traces.count"],
    "timeDimensions": [
      {
        "dimension": "traces.startedAt",
        "dateRange": ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"]
      }
    ]
  }
}
```

`batch_metrics` accepts `{ "queries": [query1, query2] }` with 1–40 queries, evaluated sequentially on one consistent PostgreSQL snapshot. Results preserve rows, annotations, normalized query, quality, pagination, and execution metadata. MCP returns JSON text and `structuredContent.data`. SQL and executable metric definitions are never accepted.

For new queries, prefer catalog models with `source.visibility: "primary"`: Traces (`traces`, `startedAt`), Spans (`spans`, `startedAt`), Evaluation Runs (`evalRuns`, `createdAt`), Evaluation Results (`evalResults`, `completedAt`), and Scores (`scoreValues`, `recordedAt`). Time dimension identifiers include the model prefix. Inspect the source's grain and unavailable fields, member definitions/denominators, and dimension grouping/filter capabilities; these differ across sources. Numeric Scores measures marked `requiresDefinition` require one compatible `scoreValues.definitionId` or grouping by that dimension. Legacy `scores` still means scorer results, not the new saved-ratings source; existing legacy queries retain their semantics. See [dashboard source contracts](dashboards.md).

`preview_dashboard` uses saved widget date windows. Each batch of at most 40 expanded queries has one snapshot; a larger preview can have multiple `meta.asOf` values. It does not inherit unsaved browser filters or a browser's current rolling window.

Busy reads return an MCP tool error (`isError: true`) whose JSON text contains `code: "READ_BUSY"` and `details.retryAfterSeconds`, even when the transport succeeds. Direct MCP clients should honor that delay, use bounded backoff with jitter and cancellation, and report exhaustion instead of empty data. Do not apply this retry policy to writes or validation/authorization errors. The CLI explicitly retries metadata, query, batch and dashboard-preview reads; metric queries allow 20 seconds per attempt, and multi-batch previews allow 120 seconds. Retries use the existing bounded read policy (at most eight retries, with a 120-second retry-start budget); an in-flight request may outlast that budget. This requires a CLI release containing the change, independently of server deployment.

## Review prompts and traces

**Reviews** contains curated review sessions, separate from SDK conversation sessions. **Human Scores** is the project's library of human review criteria; automated JavaScript/LLM **Scorers** remain a separate library. Find captured prompts with `list_traces` and inspect their payloads with `get_trace`; Datool does not have a separate saved-prompt catalog.

Call `list_human_scores` to read definitions and ordered collections. `create_human_score` accepts a `score` object with a name, optional description, and one of these types:

| Type | Configuration | Recorded value |
| --- | --- | --- |
| `numeric` | `min`, `max`, `step` (defaults 0, 1, 0.01) | Finite number within the range |
| `categorical` | `options: [{value, label}]`, `multiple: false` | One option's `value` string |
| `categorical` | `options: [{value, label}]`, `multiple: true` | Nonempty array of unique option values |
| `text` | `maxLength` (default 4000, maximum 16000) | Nonblank text within the limit |

Enum option values and labels must be unique. Labels are for display; send option values when recording answers. A `null` answer persists an unanswered card and its comment without completing the review. The browser displays every enum option, using single-selection or multiple-selection cards.

Use `create_human_score_collection` with `{name, description, scoreIds}` to group 1–30 criteria in review order. `update_human_score` accepts `{id, expectedRevision, score}`; `update_human_score_collection` accepts `{id, expectedRevision, collection}`. Reads and mutations are project scoped.

Create a review session with 1–500 unique trace IDs in playback order, an optional assignee from `get_review_options`, instructions in `prompt`, and an optional `collectionId`:

```json
{
  "name": "Weather response review",
  "prompt": "Compare each answer with the captured forecast evidence.",
  "traceIds": ["trace-first", "trace-second"],
  "assigneeUserId": "project-member-user-id",
  "collectionId": "human-collection-id"
}
```

Pass this to `create_review_session`. The session snapshots its collection and definitions so later library edits do not change an ongoing review. Change the attached collection with `update_review_session`; existing ratings and notes are retained, and completion is recalculated for the new required criteria. Existing ratings keep their original definition snapshots. Item revisions advance, so reload items before submitting more feedback. An optional UUID `idempotencyKey` makes retries of `create_review_session` return the same session for the same creator.

`get_review_session` returns ordered item IDs and progress. The MCP prompt `review_session` guides an interactive walkthrough. Call `get_review_item` for its current revision, attached `definitions`, and existing scores; inspect the trace before recording:

```json
{
  "sessionId": "review-id",
  "itemId": "review-item-id",
  "expectedRevision": 0,
  "scores": [
    { "humanScoreId": "accuracy-id", "humanScoreRevision": 1, "value": 0.8, "comment": "Temperature matches." },
    { "humanScoreId": "verdict-id", "humanScoreRevision": 1, "value": "calibrated" },
    { "humanScoreId": "issues-id", "humanScoreRevision": 1, "value": ["wrong-units", "missing-warning"] },
    { "humanScoreId": "rewrite-id", "humanScoreRevision": 1, "value": "Consider an indoor backup if it rains." }
  ]
}
```

Use definition IDs/revisions from the attached snapshot or the existing rating. Additional criteria can come from the project Human Score library. Each saved rating retains its full definition and typed value. `scorerId` and anonymous score names are not accepted for new review writes. Existing numeric ratings are imported into the Human Score library by migration, preserving comments, values and original scorer provenance.

Providing `scores` replaces the item's complete score set atomically. It is reviewed when there is at least one answer, all selected criteria have answers, and every attached collection criterion is present. An empty array reopens the item. `notes` stores up to 16,000 characters: sending notes alone preserves scores and review status; omitting notes preserves them, and an empty string clears them. At least one of `scores`, `notes` or `annotations` is required. A stale `expectedRevision` returns a conflict. The response includes previous/next item IDs for playback.

Recording accepts organization API keys with `reviews:write`, user OAuth, or a signed-in browser user. API-key and OAuth submissions are **AI-labelled**. Attribution comes from verified key ID/name or OAuth user/client, never from review input. Optional `agent: {name, model}` is client-supplied descriptive metadata. Signed-in browser submissions are human-attributed. Unchanged AI values retain their AI provenance during browser autosaves, including comment-only edits.

MCP API-key requests use `Authorization: Bearer <organization-key>` and `x-project-id`; keys stay within their organization and allowed scopes. Legacy ingestion keys cannot submit reviews. OAuth retains project binding and consent checks.

Items expose `label`, `notesProvenance`, `lastSubmission`, per-score and per-annotation `provenance`, `completionKind` and `humanVerified`. Scores also expose `editedBy`; annotations keep their author and `updatedBy`. Session `reviewedCount` is total score completion, with separate `humanReviewedCount`, `aiReviewedCount` and `aiLabelledCount`. Mixed AI/human score sets remain AI completion. Notes-only updates preserve scores and completion. Review writes never update dataset expectations or promote AI findings to verified ground truth. Legacy notes/annotations without trustworthy source information are marked Unknown provenance.

Use `export_review_items` with `{id, limit, cursor}` for complete item feedback and provenance, following `nextCursor` until null. CLI aliases include `datool reviews list|get|create|update|options|item|record`, `datool human-scores list|get|create|update`, and `datool reviews export <id> --out review.ndjson`. Generic `datool agent call` also works. See [the review guide](../content/docs/guides/reviews.mdx) for submissions and annotation references. Install the [agent workflows](../skills/README.md) with `npx skills add vinipace/datool --skill '*'`.

The player autosaves edits and allows previous/next navigation while saving. Unanswered cards and comments persist as drafts; invalid numeric input stays local for correction. A session completes when every trace has a complete review. Apply migrations through `0029_review_provenance.sql` using `bun run db:migrate`. Existing OAuth grants may need reauthorization for the review scopes.

## Validation

Set `DATOOL_TEST_DATABASE_URL` to a disposable loopback PostgreSQL target distinct from `DATABASE_URL`. Tests create and remove isolated schemas; they never use the application database implicitly.

```sh
bun test tests/organization-auth.test.ts tests/mcp.test.ts tests/auth-configuration.test.ts tests/reviews.test.ts tests/human-scores.test.ts tests/review-autosave.test.ts
bun run typecheck
```

The integration test covers real key issuance/verification/revocation, permission and organization boundaries, creation policy, MCP authorization code/PKCE/refresh flows, consent revocation, and membership removal. Google login itself still requires a configured Google client and live sign-in.
