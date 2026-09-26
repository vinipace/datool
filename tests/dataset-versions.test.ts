import assert from "node:assert/strict"
import { afterEach, expect, test } from "bun:test"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import { getTracerProjectId, registerTracerProjectId, type TracerDatabase } from "@/src/server/tracer/db"
import { closeTracerFixture, createTracerFixture } from "./helpers/tracer-fixture"

const fixtures: TracerDatabase[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(closeTracerFixture)) })
async function setup() {
  const db = await createTracerFixture()
  fixtures.push(db)
  const service = new TracerService(db)
  const dataset = await run(service.createDataset({ name: "Versioned examples" }))
  return { db, service, dataset }
}

test("row edits have atomic, ordered versions with previous values and idempotent retries", async () => {
  const { service, dataset } = await setup()
  expect(!!dataset.versionId).toBe(true)
  const original = await run(service.createDatasetItem(dataset.id, { id: "ditem_retry", input: { question: "Before" } }))
  const retryCreate = await run(service.createDatasetItem(dataset.id, { id: original.id, input: original.input }))
  expect(retryCreate.versionId).toBe(original.versionId)
  const saved = await run(service.patchDatasetItem(original.id, { input: { question: "After" }, expectedVersionId: original.versionId }))
  expect(saved.versionId === original.versionId).toBe(false)
  expect(saved.datasetRevision).toBe(2)
  const retried = await run(service.patchDatasetItem(original.id, { input: saved.input, expectedVersionId: original.versionId }))
  expect(retried.versionId).toBe(saved.versionId)
  const current = await run(service.getDataset(dataset.id))
  expect(current.versionId).toBe(saved.versionId)
  expect(current.revision).toBe(2)
  const page = await run(service.listDatasetVersions(dataset.id, { limit: 1, includeTotal: true }))
  expect(page.total).toBe(2)
  expect(page.items[0].before?.input).toEqual({ question: "Before" })
  expect(page.items[0].after?.input).toEqual({ question: "After" })
  const older = await run(service.listDatasetVersions(dataset.id, { cursor: page.nextCursor!, limit: 1 }))
  expect(older.items[0].kind).toBe("item_created")
  expect(older.items[0].before).toBeNull()
})

test("stale simultaneous edits cannot overwrite a newer row", async () => {
  const { service, dataset } = await setup()
  const row = await run(service.createDatasetItem(dataset.id, { input: "original" }))
  const outcomes = await Promise.allSettled(["first", "second"].map(input => run(service.patchDatasetItem(row.id, { input, expectedVersionId: row.versionId }))))
  expect(outcomes.filter(result => result.status === "fulfilled").length).toBe(1)
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult
  expect(rejected.reason.code).toBe("CONFLICT")
  const history = await run(service.listDatasetVersions(dataset.id, { includeTotal: true }))
  expect(history.total).toBe(2)
  expect(history.items[0].before?.input).toBe("original")
})

test("invalid and rolled-back bulk writes leave no versions", async () => {
  const { service, dataset } = await setup()
  await run(service.patchDataset(dataset.id, { fieldSchemas: { input: { schema: { type: "string" }, enforced: true } } }))
  const before = await run(service.getDataset(dataset.id))
  await assert.rejects(() => run(service.agent.bulkDataset({ datasetId: dataset.id, create: [{ input: "valid" }, { input: 42 }] })), /Input does not match/)
  const after = await run(service.getDataset(dataset.id))
  expect(after.versionId).toBe(before.versionId)
  expect(after.itemCount).toBe(0)
  expect((await run(service.listDatasetVersions(dataset.id, { includeTotal: true }))).total).toBe(1)
})

test("settings, resource imports and deletes retain history without copying unrelated rows", async () => {
  const { service, dataset } = await setup()
  const exported = await run(service.resources.export("dataset", dataset.name))
  await run(service.resources.push({ ...exported.document, description: "Imported", items: [{ key: "example", input: "one", expectedOutput: null, metadata: {} }] }, exported.revision))
  const row = (await run(service.getDataset(dataset.id))).items[0]
  await run(service.deleteDatasetItem(row.id))
  const history = await run(service.listDatasetVersions(dataset.id, { includeTotal: true }))
  expect(history.items.some(version => version.kind === "settings_updated")).toBe(true)
  expect(history.items.some(version => version.kind === "item_created")).toBe(true)
  expect(history.items[0].kind).toBe("item_deleted")
  expect(history.items[0].before?.input).toBe("one")
  expect(history.items[0].after).toBeNull()
  await run(service.deleteDataset(dataset.id))
})

test("versions and conditional writes respect project boundaries", async () => {
  const { db, service, dataset } = await setup()
  const row = await run(service.createDatasetItem(dataset.id, { input: "private" }))
  const originalProject = getTracerProjectId(db)
  registerTracerProjectId(db, "unrelated-project")
  try {
    const other = new TracerService(db)
    await assert.rejects(() => run(other.listDatasetVersions(dataset.id)), /not found/)
    await assert.rejects(() => run(other.patchDatasetItem(row.id, { input: "other", expectedVersionId: row.versionId })), /not found/)
  } finally { registerTracerProjectId(db, originalProject) }
})
