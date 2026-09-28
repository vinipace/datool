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

The convenience commands need a CLI containing review aliases. Older CLIs can use `datool agent call <operation> --input @input.json` against an updated server. MCP exposes the same operations through `describe_agent_operations`, `list_review_sessions`, `get_review_session`, `get_review_item`, `record_review` and `export_review_items`.

Organization API keys need `reviews:write` to submit and `reviews:read` to discover/read reviews and criteria. Inspecting evidence also needs `traces:read`; creating a review needs both `reviews:write` and `traces:read`. Legacy ingestion keys cannot review. CLI uses the usual environment configuration; MCP accepts `Authorization: Bearer <organization-key>` plus `x-project-id`, or project-bound user OAuth.

Create a separate test session when validating a workflow. Use `datool reviews create --input @session.json` (`create_review_session`) with `name`, `traceIds` and optionally `collectionId`. Use the IDs and revisions returned by discovery and reads.

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

Providing `scores` replaces the complete set. Include all required criteria to complete the item; `null` saves a draft, and `[]` clears scores/reopens it. Omit `scores` for notes-only or annotations-only updates to preserve existing scores and completion. Never retry a revision conflict blindly: reread, reconcile, then submit the new `expectedRevision`.

Annotations use an ID and immutable evidence reference. `outputHash` is lowercase SHA-256 of UTF-8 `JSON.stringify` of the captured input/output value, regardless of its display view. The reference includes trace/span, field, view, exact quote, prefix/suffix and start/end character offsets. Keep existing annotation entries when adding one: providing `annotations` replaces the list. Use discovery for the full schema. Span/project ownership and the evidence hash are checked server-side. Authors and edit attribution are server-derived.

Read the result back and check `label`, `notesProvenance`, score/annotation `provenance`, `completionKind` and `humanVerified`. Session `reviewedCount` is total score completion, with separate `humanReviewedCount`, `aiReviewedCount` and `aiLabelledCount`. Notes can be AI-labelled without completing an item. Human/AI completion counts describe score sets; an item with AI feedback has humanVerified=false even if its scores were human-authored. Mixed AI/human score sets remain AI completion; unchanged AI values retain provenance even when a browser autosave changes their comments.

Review writes never update dataset expectations. AI findings, completed AI ratings and observed outputs are not human-verified ground truth. Preserve dataset labels unless separately asked to curate them, and label any generated expectations explicitly. Exported rows include the same provenance; follow continuation cursors before claiming a complete export.
