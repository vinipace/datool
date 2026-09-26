import type { DatasetItem, TraceDetail } from "./contracts"
import { parseValueDocument, type ItemDraft } from "./dataset-editor"

/** Adapt a case to the existing saved React views without fetching its source trace. */
export function datasetItemViewTrace(
  item: DatasetItem,
  draft: ItemDraft
): TraceDetail {
  const attributes = parseValueDocument(draft.metadata)
  if (
    !attributes ||
    typeof attributes !== "object" ||
    Array.isArray(attributes)
  ) {
    throw new Error("Metadata must be a JSON object.")
  }
  return {
    id: item.id,
    name: `Dataset row ${item.id.slice(-8)}`,
    operation: "dataset-item",
    input: parseValueDocument(draft.input),
    output: parseValueDocument(draft.expectedOutput),
    attributes,
    startedAt: item.createdAt,
    endedAt: null,
    durationMs: null,
    status: "completed",
    sessionId: null,
    spans: [],
    scores: [],
  }
}
