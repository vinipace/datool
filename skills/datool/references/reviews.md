# AI-labelled reviews

Use this workflow to record findings against captured evidence. Inspect the deployed contract first:

```sh
datool agent tools record_review
datool reviews list
datool reviews get <session-id-or-number>
datool reviews item <session-id-or-number> --item-id <item-id>
datool traces get <trace-id>
datool human-scores list
```

The convenience commands need a CLI containing review aliases. Older CLIs can use `datool agent call <operation> --input @input.json` against an updated server. MCP exposes the same operations through `describe_agent_operations`, `list_review_sessions`, `get_review_session`, `create_review_session`, `update_review_session`, `get_review_item`, `record_review` and `export_review_items`.

Organization API keys need `reviews:write` to submit and `reviews:read` to discover/read reviews and criteria. Inspecting evidence also needs `traces:read`; creating a review needs both `reviews:write` and `traces:read`. Legacy ingestion keys cannot review. CLI uses the usual environment configuration; MCP accepts `Authorization: Bearer <organization-key>` plus `x-project-id`, or project-bound user OAuth.

Create a separate test session when validating a workflow. Use `datool reviews create --input @session.json` (`create_review_session`) with `name`, `traceIds` and optionally `collectionId`. Use the IDs and revisions returned by discovery and reads.

## Shared starting view

When supported by the deployed schema, `create_review_session` also accepts `defaultObjectViewId`. Discover a saved Object View with `list_object_views` and inspect it with `get_object_view`; it must belong to this project and support `"trace"`. The setting starts each review trace in that view and is shared by everyone using the session.

To change it, reread `get_review_session`, then call `update_review_session` with `id`, its current `expectedRevision`, and `defaultObjectViewId`. Send `null` to restore the standard trace inspector; omission preserves the existing setting. `datool reviews update <session-id> --input @session-settings.json` provides the same change without the MCP `id` envelope. This does not edit the Object View definition or the captured trace.

In the trace inspector, Trace, Evaluators, Timeline and Views are fixed tabs. Views is the searchable card library; a card or the **+** tab opens a saved view in its own closable tab. The browser WebMCP `select_trace_view` opens or activates that local tab; it does not change the session default. Closing a tab does not delete the shared definition. Notes open from the notes button beside **+** in the Human Scores header and save automatically.

## Ratings and item-specific criteria

Submit notes, scores and/or annotations:

```json
{
  "expectedRevision": 0,
  "notes": "The output contains a claim unsupported by the captured evidence.",
  "agent": { "name": "Codex", "model": "actual-model-name" },
  "scores": [
    { "humanScoreId": "criterion-id", "humanScoreRevision": 1, "value": 0 }
  ]
}
```

```sh
datool reviews record <session-id> --item-id <item-id> --input @finding.json
datool reviews export <session-id> --out review.ndjson
```

For MCP/generic calls include `sessionId` and `itemId` in the input. Agent/model metadata is optional, client-supplied context; it never establishes identity. The server binds attribution to the authenticated key ID/name or OAuth user/client. API-key and OAuth submissions are always **AI-labelled**. Clients cannot set `source`, `reviewerId`, `provenance` or `humanVerified`.

Providing `scores` replaces the complete rating set. Use `get_review_item.definitions` for this item's effective required criteria, which can differ from the session collection. Include every required criterion to complete the item; `null` saves a draft, and `[]` clears ratings/reopens it. Omit `scores` for notes-only or annotations-only updates to preserve existing scores and completion. Never retry a revision conflict blindly: reread, reconcile, then submit the new `expectedRevision`.

When asked to add or remove criteria for the current trace, send `replaceCriteria: true` with the full desired `scores` selection and the current item revision. Keep the values and comments of retained scores; use `value: null` for an added, unanswered criterion. This stores an override for only that review item. It leaves the shared score collection and other traces unchanged. `replaceCriteria: true` with `scores: []` saves an empty selection and leaves the item incomplete; it does not restore the collection. Omit `replaceCriteria` during ordinary scoring to retain the item's required criteria. Reread the item after editing and verify its definitions and ratings. Discover this option before using it on an older server.

In the Human Scores header, **+** creates a reusable criterion and **Edit** adds or removes existing criteria for the current trace. Changing a collection with `update_human_score_collection` edits a shared resource; changing `collectionId` with `update_review_session` is a session-wide action. Neither is the operation for removing one trace's criterion.

Annotations use an ID and immutable evidence reference. `outputHash` is lowercase SHA-256 of UTF-8 `JSON.stringify` of the captured input/output value, regardless of its display view. The reference includes trace/span, field, view, exact quote, prefix/suffix and start/end character offsets. Keep existing annotation entries when adding one: providing `annotations` replaces the list. Use discovery for the full schema. Span/project ownership and the evidence hash are checked server-side. Authors and edit attribution are server-derived.

Read the result back and check `label`, `notesProvenance`, score/annotation `provenance`, `completionKind` and `humanVerified`. Session `reviewedCount` is total score completion, with separate `humanReviewedCount`, `aiReviewedCount` and `aiLabelledCount`. Notes can be AI-labelled without completing an item. Human/AI completion counts describe score sets; an item with AI feedback has humanVerified=false even if its scores were human-authored. Mixed AI/human score sets remain AI completion; unchanged AI values retain provenance even when a browser autosave changes their comments.

Review writes never update dataset expectations. AI findings, completed AI ratings and observed outputs are not human-verified ground truth. Preserve dataset labels unless separately asked to curate them, and label any generated expectations explicitly. Exported rows include the same provenance; follow continuation cursors before claiming a complete export.
