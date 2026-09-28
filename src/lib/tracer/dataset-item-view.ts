import type { DatasetItem, TraceDetail } from "./contracts"
import { itemDraft, parseValueDocument, type ItemDraft } from "./dataset-editor"
import type { ObjectViewInput } from "./object-views"

export function datasetItemViewInput(item: DatasetItem, draft: ItemDraft, isNew = false): ObjectViewInput {
  const metadata = parseValueDocument(draft.metadata)
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Metadata must be a JSON object.")
  return {
    kind: "dataset-item",
    object: { ...item, input: parseValueDocument(draft.input), expectedOutput: parseValueDocument(draft.expectedOutput), metadata },
    context: { unsaved: isNew || JSON.stringify(itemDraft(item)) !== JSON.stringify(draft) },
    fields: {},
  }
}

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
