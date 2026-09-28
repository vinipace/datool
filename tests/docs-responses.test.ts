import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { agentOpenApi } from "../src/server/mcp/openapi"
import { agentOperations } from "../src/server/mcp/operations"
import outputs from "../src/server/mcp/output-schemas.json"
import type { TraceSummary } from "../src/lib/tracer/contracts"
import { viewOperations } from "../src/lib/tracer/view-operations"
import { customViewSchema } from "../src/lib/tracer/custom-views"
import { customFieldSchema } from "../src/lib/tracer/custom-fields"
import { reactViewSchema } from "../src/lib/tracer/react-views"

const document = agentOpenApi("https://datool.test")
const ajv = new Ajv2020({
  strict: false,
  validateFormats: false,
  allErrors: true,
})
ajv.addSchema({
  $id: "https://datool.test/results",
  components: document.components,
})
function validator(name: string) {
  return ajv.compile({
    $ref: `https://datool.test/results#/components/schemas/${(outputs.operations as Record<string, { $ref?: string }>)[name].$ref?.split("/").at(-1)}`,
  })
}

test("all registered operations have compilable typed result schemas", () => {
  expect(Object.keys(outputs.operations).sort()).toEqual(
    agentOperations.map((op) => op.name).sort()
  )
  for (const [name, output] of Object.entries(outputs.operations)) {
    expect(Object.keys(output).length).toBeGreaterThan(0)
    expect(() =>
      ajv.compile({
        $id: `https://datool.test/response/${name}`,
        components: document.components,
        ...output,
      })
    ).not.toThrow()
  }
})

test("trace pagination preserves nulls, arbitrary nested evidence, and lifecycle constraints", () => {
  const validate = validator("list_traces")
  const trace: TraceSummary = {
    id: "tr-example",
    name: "Example",
    operation: "workflow",
    status: "running",
    startedAt: "2026-09-25T00:00:00Z",
    endedAt: null,
    durationMs: null,
    sessionId: null,
    input: { nested: [1, true, null, { text: "hello" }] },
    output: null,
    attributes: { "example.flag": true },
  }
  expect(validate({ items: [trace], nextCursor: "next-page" })).toBe(true)
  expect(validate({ items: [], nextCursor: null })).toBe(true)
  expect(validate({ items: [trace] })).toBe(false)
  expect(
    validate({ items: [{ ...trace, status: "unknown" }], nextCursor: null })
  ).toBe(false)
  expect(
    validate({ items: [{ ...trace, durationMs: "10" }], nextCursor: null })
  ).toBe(false)
})

test("resolved resource links and mutation results retain required identities", () => {
  const resolve = validator("resolve_trace")
  expect(
    resolve({
      kind: "trace",
      id: "tr-example",
      projectId: "project",
      path: "/p/example/traces/tr-example",
      url: null,
      linkKind: "detail",
    })
  ).toBe(true)
  expect(resolve({ kind: "unknown", id: "tr-example" })).toBe(false)
  const deleted = validator("delete_dashboard")
  expect(deleted({ id: "dashboard" })).toBe(true)
  expect(deleted({})).toBe(false)
})

const viewIdentity = {
  id: "view-example", name: "Example", revision: 1,
  createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z",
}
const pageView = customViewSchema.parse({
  ...viewIdentity, resource: "traces",
  settings: { schemaVersion: 1, computedColumns: [], columnOrder: [], columnVisibility: {}, columnSizing: {}, view: "table", detailsOpen: false },
})
const customField = customFieldSchema.parse({ ...viewIdentity, code: "row.value", mode: "expression" })
const objectView = reactViewSchema.parse({
  ...viewIdentity, projectId: "project", description: "", code: "export default () => null",
  requirements: null, origin: null, author: { id: "author", name: "Author", kind: "api-key" },
})

test("every View operation publishes a structured result, including generated lifecycle names", () => {
  for (const operation of viewOperations) {
    expect(validator(operation.name)({})).toBe(false)
    expect(validator(operation.name)(null)).toBe(false)
  }
  for (const [singular, plural, definition] of [
    ["page_view", "page_views", pageView],
    ["custom_field", "custom_fields", customField],
    ["object_view", "object_views", objectView],
  ] as const) {
    const list = validator(`list_${plural}`)
    expect(list({ items: [definition], nextCursor: null })).toBe(true)
    expect(list({ items: [] })).toBe(false)
    expect(list({ items: [definition], nextCursor: 12 })).toBe(false)
    for (const action of ["get", "create", "update", "copy", "restore"]) {
      const validate = validator(`${action}_${singular}`)
      expect(validate(definition)).toBe(true)
      expect(validate({ ...definition, revision: "1" })).toBe(false)
    }
    const history = validator(`get_${singular}_history`)
    expect(history({ items: [{ definition, revision: 1, recordedAt: viewIdentity.createdAt }], nextCursor: null })).toBe(true)
    expect(history({ items: [], nextCursor: "1" })).toBe(false)
  }
})

test("resolved Page Views retain typed dependencies instead of accepting arbitrary objects", () => {
  const validate = validator("resolve_page_view")
  const resolved = { view: pageView, fields: [customField], objectViews: { trace: objectView, "dataset-item": null }, path: "/traces?pageView=view-example", applied: false }
  expect(validate(resolved)).toBe(true)
  expect(validate({ ...resolved, objectViews: { trace: { id: "incomplete" } } })).toBe(false)
  expect(validate({ ...resolved, fields: [{ id: "incomplete" }] })).toBe(false)
})

test("field evaluation and personal preference schemas preserve JSON values and revision types", () => {
  const evaluate = validator("evaluate_custom_field")
  const result = {
    id: customField.id, revision: 1, evaluated: true,
    results: [false, 0, null, { nested: ["value"] }].map(value => ({ value, missing: false })),
    limits: { rows: 20, timeoutMs: 500, resultBytes: 16384 }, query: { filter: false, sort: false },
  }
  expect(evaluate(result)).toBe(true)
  expect(evaluate({ ...result, revision: "1" })).toBe(false)
  for (const name of ["get_view_preference", "save_view_preference"]) {
    const preference = validator(name)
    expect(preference({ scope: "traces", value: { filters: ["errors"], hidden: false, width: 0 }, revision: 1 })).toBe(true)
    expect(preference({ scope: "traces", value: {}, revision: "1" })).toBe(false)
  }
})
