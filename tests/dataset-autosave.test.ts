import { expect, test } from "bun:test"
import { DatasetAutosave, type AutosaveState, type ItemValues } from "@/src/lib/tracer/dataset-autosave"
import { itemDraft, jsonDocument } from "@/src/lib/tracer/dataset-editor"
import type { DatasetItem } from "@/src/lib/tracer/contracts"

const row: DatasetItem = { id: "row", datasetId: "dataset", versionId: "original", input: { question: "Original" }, expectedOutput: null, metadata: {}, sourceTraceId: null, createdAt: "2026-09-11", updatedAt: "2026-09-11" }
const edit = (question: string) => ({ ...itemDraft(row), input: jsonDocument({ question }) })
function setup(save?: (item: DatasetItem, values: ItemValues, isNew: boolean) => Promise<DatasetItem>) {
  const writes: ItemValues[] = []
  const states: AutosaveState[] = []
  const queue = new DatasetAutosave({ delay: 10_000, schemas: () => ({}),
    changed: (_id, state) => states.push(state), saved: () => {},
    save: save ?? (async (item, values) => { writes.push(values); return { ...item, ...values, versionId: `v${writes.length}` } }),
  })
  return { queue, writes, states }
}

test("rapid edits coalesce and formatting-only edits do not save", async () => {
  const { queue, writes, states } = setup()
  queue.edit(row, edit("First"))
  queue.edit(row, edit("Latest"))
  await queue.flush()
  expect(writes.length).toBe(1)
  expect(writes[0].input).toEqual({ question: "Latest" })
  expect(states.at(-1)?.status).toBe("saved")
  const saved = states.at(-1)!.item
  queue.edit(saved, { ...itemDraft(saved), input: { format: "yaml", text: "question: Latest\n" } })
  await queue.flush()
  expect(writes.length).toBe(1)
  queue.detach()
})

test("edits during an in-flight save are serialized using the returned version", async () => {
  let resolveFirst!: (item: DatasetItem) => void
  const versions: (string | undefined)[] = []
  const { queue, states } = setup(async (item, values) => {
    versions.push(item.versionId)
    if (versions.length === 1) return new Promise(resolve => { resolveFirst = resolve })
    return { ...item, ...values, versionId: "second" }
  })
  queue.edit(row, edit("First"))
  const pending = queue.flush()
  await Promise.resolve()
  queue.edit(row, edit("Second"))
  resolveFirst({ ...row, input: { question: "First" }, versionId: "first" })
  await pending
  await queue.flush()
  expect(versions).toEqual(["original", "first"])
  expect(states.at(-1)?.item.input).toEqual({ question: "Second" })
  expect(queue.hasUnsavedChanges).toBe(false)
  queue.detach()
})

test("invalid JSON waits for correction, then saves", async () => {
  const { queue, writes, states } = setup()
  queue.edit(row, { ...itemDraft(row), input: { format: "json", text: "{" } })
  await queue.flush()
  expect(states.at(-1)?.status).toBe("invalid")
  expect(writes.length).toBe(0)
  queue.edit(row, edit("Corrected"))
  await queue.flush()
  expect(writes.length).toBe(1)
  queue.detach()
})

test("failed saves preserve the latest draft and retry without losing later edits", async () => {
  let fail = true
  const { queue, states } = setup(async (item, values) => {
    if (fail) throw new Error("Offline")
    return { ...item, ...values, versionId: "saved" }
  })
  queue.edit(row, edit("Keep me"))
  await queue.flush()
  expect(states.at(-1)?.status).toBe("error")
  expect(states.at(-1)?.preview.input).toEqual(row.input)
  expect(queue.hasUnsavedChanges).toBe(true)
  fail = false
  await queue.retry(row.id)
  expect(states.at(-1)?.item.input).toEqual({ question: "Keep me" })
  expect(states.at(-1)?.status).toBe("saved")
  queue.detach()
})

test("discard cancels pending creation and navigation flushes valid pending edits", async () => {
  const { queue, writes } = setup()
  queue.edit(row, edit("New"), true)
  const removed = await queue.remove(row.id)
  expect(removed?.isNew).toBe(true)
  await queue.flush()
  expect(writes.length).toBe(0)
  queue.edit({ ...row, id: "other" }, edit("Keep on navigation"))
  queue.detach()
  await queue.flush()
  expect(writes.length).toBe(1)
})
