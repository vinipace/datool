import assert from "node:assert/strict"
import { afterEach, describe, expect, test } from "bun:test"
import {
  assertDatasetSchemas,
  datasetFieldErrors,
} from "@/src/lib/tracer/dataset-schemas"
import {
  convertValueDocument,
  jsonDocument,
  parseValueDocument,
} from "@/src/lib/tracer/dataset-editor"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import {
  getTracerProjectId,
  registerTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

const inputSchema = {
  type: "object",
  properties: { question: { type: "string", minLength: 1 } },
  required: ["question"],
  additionalProperties: false,
}
const fixtures: TracerDatabase[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(closeTracerFixture))
})
async function setup() {
  const db = await createTracerFixture()
  fixtures.push(db)
  const service = new TracerService(db)
  const dataset = await runTracerEffect(
    service.createDataset({ name: "Schema examples" })
  )
  return { db, service, dataset }
}

describe("dataset field schema enforcement", () => {
  test("snapshots freeze schemas and dataset metadata", async () => {
    const { service, dataset } = await setup()
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        metadata: { version: 1 },
        fieldSchemas: { input: { schema: inputSchema, enforced: true } },
      })
    )
    const snapshot = await runTracerEffect(
      service.agent.createSnapshot(dataset.id)
    )
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        metadata: { version: 2 },
        fieldSchemas: { input: { schema: null, enforced: false } },
      })
    )
    const frozen = await service.agent.snapshotArtifact(dataset.id, snapshot.id)
    expect(frozen.metadata).toEqual({ version: 1 })
    expect(frozen.fieldSchemas?.input).toEqual({
      schema: inputSchema,
      enforced: true,
    })
    const next = await runTracerEffect(service.agent.createSnapshot(dataset.id))
    expect(next.contentHash === snapshot.contentHash).toBe(false)
  })

  test("resource sync cannot bypass enforced schemas or partially update the dataset", async () => {
    const { service, dataset } = await setup()
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        fieldSchemas: { input: { schema: inputSchema, enforced: true } },
      })
    )
    const current = await runTracerEffect(
      service.resources.export("dataset", dataset.name)
    )
    await assert.rejects(
      () =>
        runTracerEffect(
          service.resources.push(
            {
              ...current.document,
              description: "Must roll back",
              items: [
                { key: "bad", input: {}, expectedOutput: null, metadata: {} },
              ],
            },
            current.revision
          )
        ),
      /Input does not match/
    )
    const result = await runTracerEffect(service.getDataset(dataset.id))
    expect(result.itemCount).toBe(0)
    expect(result.description).toBeNull()
  })

  test("persists independent schemas and dataset metadata, while annotations permit unmatched rows", async () => {
    const { service, dataset } = await setup()
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        metadata: { team: "quality" },
        fieldSchemas: { input: { schema: inputSchema, enforced: false } },
      })
    )
    await runTracerEffect(
      service.createDatasetItem(dataset.id, { input: "legacy text" })
    )
    const result = await runTracerEffect(service.getDataset(dataset.id))
    expect(result.metadata).toEqual({ team: "quality" })
    expect(result.fieldSchemas?.input).toEqual({
      schema: inputSchema,
      enforced: false,
    })
    expect(result.items[0].input).toBe("legacy text")
  })

  test("checks create and merged patch values; rejected writes leave data unchanged", async () => {
    const { service, dataset } = await setup()
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        fieldSchemas: {
          input: { schema: inputSchema, enforced: true },
          expectedOutput: { schema: { type: "string" }, enforced: true },
          metadata: {
            schema: {
              type: "object",
              required: ["locale"],
              properties: { locale: { enum: ["en", "pt"] } },
            },
            enforced: true,
          },
        },
      })
    )
    await assert.rejects(
      () =>
        runTracerEffect(service.createDatasetItem(dataset.id, { input: {} })),
      new RegExp("Input does not match")
    )
    const item = await runTracerEffect(
      service.createDatasetItem(dataset.id, {
        input: { question: "Hello?" },
        expectedOutput: "Hi",
        metadata: { locale: "en" },
      })
    )
    await assert.rejects(
      () =>
        runTracerEffect(
          service.patchDatasetItem(item.id, { expectedOutput: null })
        ),
      new RegExp("Expected does not match")
    )
    await assert.rejects(
      () =>
        runTracerEffect(service.patchDatasetItem(item.id, { metadata: {} })),
      new RegExp("Metadata does not match")
    )
    const patched = await runTracerEffect(
      service.patchDatasetItem(item.id, { metadata: { locale: "pt" } })
    )
    expect(patched.input).toEqual({ question: "Hello?" })
    expect(patched.expectedOutput).toBe("Hi")
    expect(patched.metadata).toEqual({ locale: "pt" })
    expect(
      (await runTracerEffect(service.getDataset(dataset.id))).itemCount
    ).toBe(1)
  })

  test("enforcement can be enabled for future writes and turned off without rewriting existing rows", async () => {
    const { service, dataset } = await setup()
    const item = await runTracerEffect(
      service.createDatasetItem(dataset.id, { input: "old" })
    )
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        fieldSchemas: { input: { schema: inputSchema, enforced: true } },
      })
    )
    expect(
      (await runTracerEffect(service.getDataset(dataset.id))).items[0].input
    ).toBe("old")
    await assert.rejects(
      () =>
        runTracerEffect(
          service.patchDatasetItem(item.id, { metadata: { edited: true } })
        ),
      new RegExp("Input does not match")
    )
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        fieldSchemas: { input: { schema: inputSchema, enforced: false } },
      })
    )
    await runTracerEffect(service.patchDatasetItem(item.id, { input: 7 }))
    expect(
      (await runTracerEffect(service.getDataset(dataset.id))).items[0].input
    ).toBe(7)
  })

  test("invalid schemas and missing enforced schemas are rejected atomically", async () => {
    const { service, dataset } = await setup()
    await assert.rejects(
      () =>
        runTracerEffect(
          service.patchDataset(dataset.id, {
            description: "Must roll back",
            fieldSchemas: {
              input: { schema: { type: "typo" }, enforced: true },
            },
          })
        ),
      new RegExp("schema")
    )
    await assert.rejects(
      () =>
        runTracerEffect(
          service.patchDataset(dataset.id, {
            fieldSchemas: { metadata: { schema: null, enforced: true } },
          })
        ),
      new RegExp("needs a schema")
    )
    expect(
      (await runTracerEffect(service.getDataset(dataset.id))).description
    ).toBeNull()
  })

  test("bulk imports roll back every row when one fails enforcement", async () => {
    const { service, dataset } = await setup()
    await runTracerEffect(
      service.patchDataset(dataset.id, {
        fieldSchemas: { input: { schema: inputSchema, enforced: true } },
      })
    )
    await assert.rejects(
      () =>
        runTracerEffect(
          service.agent.bulkDataset({
            datasetId: dataset.id,
            create: [{ input: { question: "valid" } }, { input: {} }],
          })
        ),
      new RegExp("Input does not match")
    )
    expect(
      (await runTracerEffect(service.getDataset(dataset.id))).itemCount
    ).toBe(0)
  })

  test("nested JSON filters run before page limits and counts, and support typed values", async () => {
    const { service, dataset } = await setup()
    for (let i = 0; i < 7; i++)
      await runTracerEffect(
        service.createDatasetItem(dataset.id, {
          input: { question: i > 2 ? "Find me" : "Ignore me" },
          metadata: { reviewed: i > 2, rank: i },
        })
      )
    const filter =
      'input.question : "find" metadata.reviewed = true metadata.rank >= 4'
    const first = await runTracerEffect(
      service.listDatasetItems(dataset.id, {
        filter,
        limit: 2,
        includeTotal: true,
      })
    )
    expect(first.items).toHaveLength(2)
    expect(first.total).toBe(3)
    const second = await runTracerEffect(
      service.listDatasetItems(dataset.id, {
        filter,
        limit: 2,
        cursor: first.nextCursor,
      })
    )
    expect(second.items).toHaveLength(1)
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size
    ).toBe(3)
    expect(
      first.items.every(compileCollectionFilter("datasetItems", filter))
    ).toBe(true)
    await assert.rejects(() =>
      runTracerEffect(
        service.listDatasetItems(dataset.id, { filter: 'unknown = "x"' })
      )
    )
  })

  test("schemas, filtered rows and metadata cannot cross project scope", async () => {
    const { service, db, dataset } = await setup()
    const item = await runTracerEffect(
      service.createDatasetItem(dataset.id, { input: {} })
    )
    const original = getTracerProjectId(db)
    registerTracerProjectId(db, "another-project")
    const other = new TracerService(db)
    await assert.rejects(
      () =>
        runTracerEffect(
          other.patchDataset(dataset.id, { metadata: { invalid: true } })
        ),
      new RegExp("was not found")
    )
    await assert.rejects(
      () =>
        runTracerEffect(other.patchDatasetItem(item.id, { input: "invalid" })),
      new RegExp("was not found")
    )
    await assert.rejects(
      () =>
        runTracerEffect(
          other.listDatasetItems(dataset.id, { filter: 'input : "x"' })
        ),
      new RegExp("was not found")
    )
    registerTracerProjectId(db, original)
  })
})

describe("dataset editor documents", () => {
  test("JSON and YAML round-trip structured values without changing strings, nulls or booleans", () => {
    const value = {
      text: "null",
      answer: null,
      enabled: false,
      count: 0,
      items: ["a", "b"],
    }
    const yaml = convertValueDocument(jsonDocument(value), "yaml")
    expect(parseValueDocument(yaml)).toEqual(value)
    expect(parseValueDocument(convertValueDocument(yaml, "json"))).toEqual(
      value
    )
    expect(parseValueDocument({ text: "hello", format: "text" })).toBe("hello")
    expect(() => convertValueDocument(jsonDocument(value), "text")).toThrow(
      "string values"
    )
  })
  test("invalid JSON, circular YAML and non-finite values never silently change into valid JSON", () => {
    expect(() => parseValueDocument({ text: "{", format: "json" })).toThrow()
    expect(() =>
      parseValueDocument({ text: "&a {self: *a}", format: "yaml" })
    ).toThrow()
    expect(() =>
      parseValueDocument({ text: "value: .nan", format: "yaml" })
    ).toThrow()
  })
  test("schema formats validate and row data is never coerced", () => {
    expect(
      datasetFieldErrors({ type: "string", format: "email" }, "invalid").length
    ).toBeGreaterThan(0)
    expect(
      datasetFieldErrors({ type: "integer" }, "12").length
    ).toBeGreaterThan(0)
    expect(() =>
      assertDatasetSchemas({
        input: { enforced: true, schema: { $async: true, type: "string" } },
      })
    ).toThrow("Asynchronous")
  })
})
