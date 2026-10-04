import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { getTracerProjectId } from "../src/server/tracer/db"
import { createViewLibrary } from "../src/server/tracer/view-library"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { withWorkspace } from "../src/server/auth/context"
import { customFieldSchema } from "../src/lib/tracer/custom-fields"
import { customViewSchema } from "../src/lib/tracer/custom-views"

test("React and MDX Page Views persist source, retain history, and restore alongside existing table views", async () => {
  const db = await createTracerFixture()
  try {
    const library = createViewLibrary(db)
    for (const kind of ["react", "mdx"] as const) {
      const definition = {
        resource: "traces", name: "Trace cards",
        settings: { schemaVersion: 1, renderer: { kind, code: kind === "mdx" ? "# Page\n\nLoaded {props.rows.length} rows" : "export default function Page({ rows }) { return rows.length }" } },
      }
      const initial = customViewSchema.parse(await run(library.create("page-view", definition)))
      expect(customViewSchema.parse(await run(createViewLibrary(db).get("page-view", initial.id))).settings.renderer).toEqual(definition.settings.renderer)
      const next = { ...definition, settings: { ...definition.settings, renderer: { kind, code: kind === "mdx" ? "# Updated page" : "export default function Page() { return 'Updated page' }" } }, expectedRevision: initial.revision }
      const updated = customViewSchema.parse(await run(library.update("page-view", initial.id, next)))
      expect(updated.settings.renderer?.code).toContain("Updated page")
      await assert.rejects(run(library.update("page-view", initial.id, next)), /changed/)
      expect(customViewSchema.parse(await run(library.get("page-view", initial.id, 1))).settings.renderer).toEqual(definition.settings.renderer)
      const restored = customViewSchema.parse(await run(library.restore("page-view", initial.id, 1, updated.revision)))
      expect(restored.settings.renderer).toEqual(definition.settings.renderer)
      expect(restored.revision).toBe(3)
      await assert.rejects(run(library.create("page-view", { ...definition, settings: { schemaVersion: 1, renderer: { kind, code: " " } } })), /code/)
      await assert.rejects(run(library.create("page-view", { ...definition, settings: { schemaVersion: 1, renderer: { kind: "html", code: "<p>Unsupported</p>" } } })), /react/)
    }
  } finally { await closeTracerFixture(db) }
})

test("Page View history pins dependencies without replacing the shared field", async () => {
  const db = await createTracerFixture()
  try {
    const library = createViewLibrary(db)
    const fieldInput = { name: "Count", code: "row.count", mode: "expression", objectTypes: ["trace"], resultType: "number" }
    const field = customFieldSchema.parse(await run(library.create("custom-field", fieldInput)))
    const input = { resource: "traces", name: "Errors", settings: { schemaVersion: 1, computedColumns: [], customFields: [{ id: field.id }], columnOrder: [field.id], columnVisibility: {}, columnSizing: {}, view: "table", detailsOpen: true, queryParams: { filter: ["status = error"], sort: ["durationMs:desc"] }, fieldViews: { output: "yaml" }, rowHeight: "tall" } }
    const page = customViewSchema.parse(await run(library.create("page-view", input)))
    const historical = customViewSchema.parse(await run(library.get("page-view", page.id, 1)))
    expect(historical.settings.customFields).toEqual([{ id: field.id, revision: 1 }])
    await run(library.update("custom-field", field.id, { ...fieldInput, code: "row.count * 2", expectedRevision: 1 }))
    await assert.rejects(run(library.update("custom-field", field.id, { ...fieldInput, expectedRevision: 1 })), /changed/)
    const restored = customViewSchema.parse(await run(library.restore("page-view", page.id, 1, 1)))
    expect(restored.revision).toBe(2)
    expect(restored.settings.customFields).toEqual([{ id: field.id, revision: 1 }])
    const resolved = await run(library.resolve(page.id))
    expect(customFieldSchema.parse(resolved.fields[0]).code).toBe("row.count")
    expect(customFieldSchema.parse(await run(library.get("custom-field", field.id))).code).toBe("row.count * 2")
    await assert.rejects(run(library.delete("custom-field", field.id, 2)), /referenced/)
    expect((await run(library.history("custom-field", field.id))).items).toHaveLength(2)
    expect((await run(library.list("page-view", { resource: "traces", limit: 1 }))).items).toHaveLength(1)
  } finally { await closeTracerFixture(db) }
})

test("field execution preserves false, zero, objects and null, rejects wrong kinds and runaway expressions", async () => {
  const db = await createTracerFixture()
  try {
    const library = createViewLibrary(db)
    const field = await run(library.create("custom-field", { name: "Value", code: "row.value", mode: "expression", objectTypes: ["trace"] }))
    const output = await run(library.evaluate({ id: field.id, kind: "trace", rows: [{ value: false }, { value: 0 }, { value: { a: 1 } }, { value: null }, {}] }))
    expect(output.results.map(cell => cell.value)).toEqual([false, 0, { a: 1 }, null, null])
    expect(output.results[4]).toMatchObject({ missing: true })
    await assert.rejects(run(library.evaluate({ id: field.id, kind: "dataset-item", rows: [{}] })), /supports trace/)
    const runaway = await run(library.create("custom-field", { name: "Timeout", code: "(()=>{while(true){}})()", mode: "expression", objectTypes: ["trace"] }))
    expect((await run(library.evaluate({ id: runaway.id, kind: "trace", rows: [{}] }))).results[0]).toMatchObject({ error: { kind: "timeout" } })
  } finally { await closeTracerFixture(db) }
}, 15000)

test("personal preferences are durable, revision checked and isolated by principal", async () => {
  const db = await createTracerFixture()
  try {
    const library = createViewLibrary(db)
    const identity = { kind: "api-key" as const, apiKeyId: "first", projectId: getTracerProjectId(db), organizationId: "test", scopes: ["views:read", "views:write"] }
    await withWorkspace(identity, async () => {
      expect((await run(library.preference("traces"))).revision).toBe(0)
      await run(library.savePreference({ scope: "traces", expectedRevision: 0, value: { rowHeight: "tall" } }))
      await assert.rejects(run(library.savePreference({ scope: "traces", expectedRevision: 0, value: {} })), /changed/)
      expect((await run(createViewLibrary(db).preference("traces"))).value).toEqual({ rowHeight: "tall" })
    })
    await withWorkspace({ ...identity, apiKeyId: "second" }, async () => expect((await run(library.preference("traces"))).revision).toBe(0))
  } finally { await closeTracerFixture(db) }
})
