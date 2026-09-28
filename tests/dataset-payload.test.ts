import { expect, test } from "bun:test"
import { readJson } from "../src/server/tracer/http"
import { datasetItemPatch, datasetItemPreview, DATASET_WRITE_MAX_BYTES } from "../src/lib/tracer/dataset-payload"
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
  expect(datasetItemPreview(preview)).toBe(preview)
})
