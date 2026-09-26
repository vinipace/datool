import { createTracerFixture, closeTracerFixture } from "./helpers/tracer-fixture"
import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCustomFieldService } from "@/src/server/tracer/custom-fields"
import { runTracerEffect as run } from "@/src/server/tracer/effect"

test("global fields persist, reuse names, reject conflicts, and protect against stale imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "datool-fields-"))
  const db = await createTracerFixture()
  try {
    const service = createCustomFieldService(db)
    const field = { id: "response", name: "Response", mode: "expression", code: "row.input.response", format: "markdown" }
    await run(service.save({ field }))
    expect((await run(service.save({ field: { ...field, id: "duplicate" } }))).id).toBe("response")
    let failure: unknown
    try { await run(service.save({ field: { ...field, id: "conflict", code: "row.output" } })) } catch (error) { failure = error }
    expect(String(failure)).toContain("already exists")
    await run(service.save({ field: { ...field, code: "row.output" }, overwrite: true }))
    expect((await run(service.save({ field }))).code).toBe("row.output")
    const fresh = createCustomFieldService(db)
    const fields = await run(fresh.list())
    expect(fields).toHaveLength(1)
    expect(fields[0].code).toBe("row.output")
  } finally { await closeTracerFixture(db); await rm(dir, { recursive: true, force: true }) }
})

test("registry persistence canonicalizes selected IDs and failed writes preserve selection", async () => {
  const { createComputedColumnStore } = await import("@/src/lib/tracer/computed-column-store")
  const values = new Map<string, string>()
  let fail = false
  const store = createComputedColumnStore("eval", () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }), undefined, async columns => {
    if (fail) throw new Error("Registry unavailable")
    return columns.map(column => ({ ...column, id: "canonical" }))
  })
  store.load()
  await store.update([{ id: "duplicate", name: "Brands", mode: "expression", code: "row.output.brands" }], true)
  expect(store.getSnapshot().columns[0].id).toBe("canonical")
  fail = true
  let failure: unknown
  try { await store.update([], true) } catch (error) { failure = error }
  expect(String(failure)).toContain("Registry unavailable")
  expect(store.getSnapshot().columns).toHaveLength(1)
})
