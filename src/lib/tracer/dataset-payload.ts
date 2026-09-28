import type { DatasetItem, DatasetItemPreview, PatchDatasetItemInput } from "./contracts"
import type { ItemValues } from "./dataset-autosave"
import { canonicalJson } from "./resource-document"

// A bounded increase for dataset writes; evaluation evidence has its own budget.
export const DATASET_WRITE_MAX_BYTES = 4 * 1024 * 1024
export const DATASET_ITEM_READ_MAX_BYTES = 32 * 1024 * 1024
export const DATASET_PREVIEW_FIELD_BYTES = 16 * 1024
export const DATASET_PREVIEW_CHARACTERS = 128

export function agentRequestMaxBytes(operation: unknown) {
  return typeof operation === "string" && ["create_dataset_item", "update_dataset_item", "bulk_dataset_items"].includes(operation)
    ? DATASET_WRITE_MAX_BYTES
    : 1024 * 1024
}

/** Keep loaded/edited values out of table renderers too; never mutate the editor's row. */
export function datasetItemPreview(item: DatasetItemPreview): DatasetItemPreview {
  if (item.omittedFields) return item
  const row: DatasetItemPreview = { ...item }
  const omitted: NonNullable<DatasetItemPreview["omittedFields"]> = {}
  for (const field of ["input", "expectedOutput", "metadata", "sourceSpanEvidence"] as const) {
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
export function datasetItemPatch(item: DatasetItem, values: ItemValues): PatchDatasetItemInput {
  const patch: PatchDatasetItemInput = { expectedVersionId: item.versionId }
  if (canonicalJson(item.input) !== canonicalJson(values.input)) patch.input = values.input
  if (canonicalJson(item.expectedOutput) !== canonicalJson(values.expectedOutput)) patch.expectedOutput = values.expectedOutput
  if (canonicalJson(item.metadata) !== canonicalJson(values.metadata)) patch.metadata = values.metadata
  if (item.sourceTraceId !== values.sourceTraceId) patch.sourceTraceId = values.sourceTraceId
  return patch
}
