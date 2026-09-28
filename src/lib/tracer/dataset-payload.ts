import type { DatasetItemField, DatasetItemPreview, PatchDatasetItemInput } from "./contracts"
import type { ItemValues } from "./dataset-autosave"
import { canonicalJson } from "./resource-document"

// A bounded increase for dataset writes; evaluation evidence has its own budget.
export const DATASET_WRITE_MAX_BYTES = 4 * 1024 * 1024
export const DATASET_ITEM_READ_MAX_BYTES = 32 * 1024 * 1024
export const DATASET_PREVIEW_FIELD_BYTES = 16 * 1024
export const DATASET_PREVIEW_CHARACTERS = 128
export const datasetItemFields = ["input", "expectedOutput", "metadata", "sourceSpanEvidence"] as const

export function agentRequestMaxBytes(operation: unknown) {
  return typeof operation === "string" && ["create_dataset_item", "update_dataset_item", "bulk_dataset_items"].includes(operation)
    ? DATASET_WRITE_MAX_BYTES
    : 1024 * 1024
}

/** Bound large values unless explicitly loaded; never mutate the source row. */
export function datasetItemPreview(item: DatasetItemPreview, loadedFields: readonly DatasetItemField[] = []): DatasetItemPreview {
  const row: DatasetItemPreview = { ...item }
  const omitted = { ...item.omittedFields }
  for (const field of datasetItemFields) {
    if (omitted[field] || loadedFields.includes(field)) continue
    const text = JSON.stringify(item[field] ?? null)
    // UTF-8 uses at most three bytes per UTF-16 code unit; avoid allocating bytes for small values.
    if (text.length * 3 <= DATASET_PREVIEW_FIELD_BYTES) continue
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes <= DATASET_PREVIEW_FIELD_BYTES) continue
    // Match PostgreSQL's character count without splitting surrogate pairs or copying the full value.
    const preview = Array.from(text.slice(0, DATASET_PREVIEW_CHARACTERS * 2)).slice(0, DATASET_PREVIEW_CHARACTERS).join("")
    omitted[field] = { bytes, preview }
    if (field === "metadata") row.metadata = {}
    else row[field] = null
    if (field === "sourceSpanEvidence") row.observedOutput = null
  }
  return Object.keys(omitted).length ? { ...row, omittedFields: omitted } : item
}

/** Compare against the last acknowledged row, including edits queued during a save. */
export function datasetItemPatch(item: DatasetItemPreview, values: ItemValues): PatchDatasetItemInput {
  const patch: PatchDatasetItemInput = { expectedVersionId: item.versionId }
  if (!item.omittedFields?.input && canonicalJson(item.input) !== canonicalJson(values.input)) patch.input = values.input
  if (!item.omittedFields?.expectedOutput && canonicalJson(item.expectedOutput) !== canonicalJson(values.expectedOutput)) patch.expectedOutput = values.expectedOutput
  if (!item.omittedFields?.metadata && canonicalJson(item.metadata) !== canonicalJson(values.metadata)) patch.metadata = values.metadata
  if (item.sourceTraceId !== values.sourceTraceId) patch.sourceTraceId = values.sourceTraceId
  return patch
}

/** Merge only the requested field; other fields can contain previews or local edits. */
export function mergeDatasetItemField(item: DatasetItemPreview, loaded: DatasetItemPreview, field: DatasetItemField): DatasetItemPreview {
  if (item.id !== loaded.id || item.versionId !== loaded.versionId) throw new Error("This row changed. Reopen the dataset to load its latest values.")
  if (loaded.omittedFields?.[field]) throw new Error("This field could not be loaded. Try again.")
  const merged = { ...item, [field]: loaded[field], omittedFields: { ...item.omittedFields } }
  if (field === "sourceSpanEvidence") merged.observedOutput = loaded.observedOutput
  delete merged.omittedFields[field]
  if (!Object.keys(merged.omittedFields).length) delete (merged as DatasetItemPreview).omittedFields
  return merged
}
