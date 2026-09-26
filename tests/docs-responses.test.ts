import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import { agentOpenApi } from "../src/server/mcp/openapi"
import { agentOperations } from "../src/server/mcp/operations"
import outputs from "../src/server/mcp/output-schemas.json"
import type { TraceSummary } from "../src/lib/tracer/contracts"

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
