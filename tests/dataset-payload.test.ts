import { expect, test } from "bun:test"
import { readJson } from "../src/server/tracer/http"
import { datasetItemPatch, datasetItemPreview, DATASET_WRITE_MAX_BYTES, mergeDatasetItemField } from "../src/lib/tracer/dataset-payload"
import { parseDatasetItemFields } from "../src/server/tracer/validation"
import { DatasetAutosave } from "../src/lib/tracer/dataset-autosave"
import { itemDraft, jsonDocument } from "../src/lib/tracer/dataset-editor"
import type { DatasetItem, PatchDatasetItemInput } from "../src/lib/tracer/contracts"

const row: DatasetItem = {
  id: "large", datasetId: "dataset", input: { text: "x".repeat(2 * 1024 * 1024) },
  expectedOutput: { ok: true }, metadata: { tag: "old" }, sourceTraceId: null,
  createdAt: "2026-09-28", updatedAt: "2026-09-28", versionId: "v1",
}

test("large dataset writes are bounded independently of other requests, including chunked UTF-8", async () => {
  const body = JSON.stringify({ input: row.input })
  const request = () => new Request("http://localhost/items", { method: "POST", body })
  expect(await readJson(request()).catch(error => error)).toMatchObject({ status: 413 })
  expect(await readJson(request(), DATASET_WRITE_MAX_BYTES)).toEqual({ input: row.input })
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("é".repeat(600_000))) },
    cancel() { cancelled = true },
  })
  expect(await readJson(new Request("http://localhost/items", { method: "POST", body: stream, duplex: "half" } as RequestInit), DATASET_WRITE_MAX_BYTES).catch(error => error))
    .toMatchObject({ status: 413, details: { maxBytes: DATASET_WRITE_MAX_BYTES } })
  expect(cancelled).toBe(true)
})

test("metadata-only autosaves omit large input and preserve null clears and optimistic versions", async () => {
  const patches: PatchDatasetItemInput[] = []
  const queue = new DatasetAutosave({
    delay: 10_000, schemas: () => ({}), changed: () => {}, saved: () => {},
    save: async (current, values) => {
      const patch = datasetItemPatch(current, values)
      patches.push(patch)
      return { ...current, ...patch, versionId: "v2" }
    },
  })
  queue.edit(row, { ...itemDraft(row), metadata: jsonDocument({ tag: "new" }), expectedOutput: jsonDocument(null) })
  await queue.flush()
  expect(patches).toEqual([{ metadata: { tag: "new" }, expectedOutput: null, expectedVersionId: "v1" }])
  expect(JSON.stringify(patches).length).toBeLessThan(150)
  queue.detach()
})

test("table previews keep 128 Unicode characters per large field without changing complete values", () => {
  const input = { text: "😀".repeat(10_000) }
  const metadata = { notes: "é".repeat(10_000) }
  const complete = { ...row, input, metadata }
  const preview = datasetItemPreview(complete)
  for (const field of ["input", "metadata"] as const) {
    expect(preview.omittedFields?.[field]?.preview).toBe(Array.from(JSON.stringify(complete[field])).slice(0, 128).join(""))
    expect(preview.omittedFields?.[field]?.bytes).toBe(Buffer.byteLength(JSON.stringify(complete[field])))
  }
  expect(preview.input).toBeNull()
  expect(preview.metadata).toEqual({})
  expect(complete.input).toBe(input)
  expect(complete.metadata).toBe(metadata)
  expect(datasetItemPreview(preview)).toEqual(preview)
})

test("field reads and save responses keep other large fields omitted, including partially loaded rows", () => {
  const complete = { ...row, metadata: { notes: "x".repeat(20_000) } }
  const loaded = datasetItemPreview(complete, ["input"])
  expect(loaded.input).toEqual(complete.input)
  expect(loaded.omittedFields?.input).toBeUndefined()
  expect(loaded.metadata).toEqual({})
  expect(loaded.omittedFields?.metadata).toBeDefined()
  expect(datasetItemPreview(loaded).omittedFields?.input).toBeDefined()
  const merged = mergeDatasetItemField(datasetItemPreview(complete), loaded, "input")
  expect(merged).toEqual(loaded)
  expect(() => mergeDatasetItemField({ ...merged, versionId: "newer" }, loaded, "metadata")).toThrow("row changed")
  expect(() => mergeDatasetItemField(merged, loaded, "metadata")).toThrow("could not be loaded")
  expect(parseDatasetItemFields(null)).toBeUndefined()
  expect(parseDatasetItemFields("")).toEqual([])
  expect(parseDatasetItemFields("input,metadata")).toEqual(["input", "metadata"])
  expect(() => parseDatasetItemFields("input,unknown")).toThrow("Invalid dataset item fields")
})

test("editing small fields skips unloaded schema checks and hydrates against the acknowledged version", async () => {
  const preview = datasetItemPreview(row)
  const patches: PatchDatasetItemInput[] = []
  const queue = new DatasetAutosave({
    delay: 10_000, schemas: () => ({ input: { enforced: true, schema: { type: "object", required: ["text"] } } }), changed: () => {}, saved: () => {},
    save: async (current, values) => {
      const patch = datasetItemPatch(current, values)
      patches.push(patch)
      return { ...current, ...patch, versionId: "v2" }
    },
  })
  const draft = { ...itemDraft(preview), metadata: jsonDocument({ tag: "new" }) }
  queue.edit(preview, draft)
  await queue.flush()
  expect(patches).toEqual([{ metadata: { tag: "new" }, expectedVersionId: "v1" }])
  const hydrated = queue.hydrateField(preview, { ...row, versionId: "v2" }, "input")
  expect(hydrated.metadata).toEqual({ tag: "new" })
  expect(hydrated.omittedFields).toBeUndefined()
  queue.edit(hydrated, { ...draft, input: jsonDocument({ text: "changed" }) })
  await queue.flush()
  expect(patches[1]).toEqual({ input: { text: "changed" }, expectedVersionId: "v2" })
  expect(datasetItemPatch(preview, { input: "placeholder edit", expectedOutput: row.expectedOutput, metadata: row.metadata, sourceTraceId: null })).toEqual({ expectedVersionId: "v1" })
  queue.detach()
})
