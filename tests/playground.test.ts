import { describe, test, expect } from "bun:test"
import assert from "node:assert/strict"
import {
  definitionSchema,
  playgroundSchema,
  type Attempt,
  type Playground,
} from "../src/lib/playground/contracts"
import {
  resolveNode,
  validateGraph,
  atPath,
} from "../src/lib/playground/resolve"
import { validateSchema } from "../src/server/playground/schema"
import { liveBridge, type State } from "../src/server/playground/storage"

const apps = ["context", "plan"].map((id) => ({
  ...definitionSchema.parse({
    id,
    name: id,
    inputSchema: {},
    outputSchema: {},
  }),
  revision: 1,
}))
function fixture() {
  const playground: Playground = {
    ...playgroundSchema.parse({
      name: "test",
      shared: { companyId: "A" },
      nodes: [
        {
          id: "context",
          appId: "context",
          position: { x: 0, y: 0 },
          bindings: { companyId: { source: "shared", path: "companyId" } },
        },
        {
          id: "plan",
          appId: "plan",
          position: { x: 1, y: 0 },
          bindings: {
            companyId: { source: "shared", path: "companyId" },
            context: { source: "output", nodeId: "context", path: "" },
          },
        },
      ],
    }),
    id: "p",
    revision: 1,
  }
  const resolved = resolveNode(playground, "context", [], apps)
  const attempt: Attempt = {
    id: "a",
    playgroundId: "p",
    nodeId: "context",
    appId: "context",
    appRevision: 1,
    createdAt: new Date().toISOString(),
    ...resolved,
    output: { companyId: "A", text: "chosen result" },
    status: "completed",
    evalRunIds: [],
  }
  playground.nodes[0].selectedAttemptId = attempt.id
  return { playground, attempts: [attempt] }
}
describe("connected playground", () => {
  test("resolves shared company and the explicitly selected upstream output", () => {
    const { playground, attempts } = fixture()
    const candidate = {
      ...attempts[0],
      id: "new-candidate",
      output: { companyId: "A", text: "not selected" },
    }
    const resolved = resolveNode(
      playground,
      "plan",
      [...attempts, candidate],
      apps
    )
    expect(resolved.input).toEqual({
      companyId: "A",
      context: { companyId: "A", text: "chosen result" },
    })
    expect(resolved.upstream).toEqual({ context: "a" })
  })
  test("blocks cross-company, changed app revisions, and foreign-playground attempts", () => {
    const { playground, attempts } = fixture()
    playground.shared.companyId = "B"
    assert.throws(
      () => resolveNode(playground, "plan", attempts, apps),
      /outdated/
    )
    playground.shared.companyId = "A"
    assert.throws(
      () =>
        resolveNode(
          playground,
          "plan",
          attempts,
          apps.map((a) => ({ ...a, revision: 2 }))
        ),
      /outdated/
    )
    assert.throws(
      () =>
        resolveNode(
          playground,
          "plan",
          [{ ...attempts[0], playgroundId: "other" }],
          apps
        ),
      /Select a completed/
    )
  })
  test("requires a successful selection for dependencies and rejects cycles", () => {
    const { playground, attempts } = fixture()
    assert.throws(
      () =>
        resolveNode(
          playground,
          "plan",
          [{ ...attempts[0], status: "error" }],
          apps
        ),
      /Select a completed/
    )
    playground.nodes[0].dependsOn = ["plan"]
    assert.throws(() => validateGraph(playground.nodes), /cycle/)
    playground.nodes[0].dependsOn = ["missing"]
    assert.throws(() => validateGraph(playground.nodes), /Missing dependency/)
  })
  test("schema validation rejects invalid required fields and ranges", () => {
    const schema = {
      type: "object",
      required: ["score"],
      properties: { score: { type: "number", minimum: 0, maximum: 100 } },
      additionalProperties: false,
    }
    validateSchema(schema, { score: 55 })
    assert.throws(() => validateSchema(schema, { score: 101 }))
    assert.throws(() => validateSchema(schema, {}))
    assert.throws(() => atPath({}, "__proto__.bad"), /Invalid field/)
  })
  test("bridge expiry or revision mismatch never removes app definitions", () => {
    const state: State = {
      apps,
      attempts: [],
      playgrounds: [],
      bridges: [
        {
          id: "bridge",
          appIds: ["context"],
          revisions: { context: 1 },
          token: "secret",
          url: "http://localhost:1/call",
          expiresAt: Date.now() + 15_000,
        },
      ],
    }
    expect(!!liveBridge(state, "context")).toBe(true)
    state.bridges[0].expiresAt = Date.now() - 1
    expect(liveBridge(state, "context")).toBeUndefined()
    expect(state.apps.length).toBe(2)
    state.bridges[0].expiresAt = Date.now() + 15_000
    state.bridges[0].revisions.context = 0
    expect(liveBridge(state, "context")).toBeUndefined()
  })
})


test("node scorer choices preserve defaults versus explicitly disabled scoring", () => {
  const base = { name: "Scoring", nodes: [{ id: "n", appId: "context", position: { x: 0, y: 0 } }] }
  expect(playgroundSchema.parse(base).nodes[0].evaluatorIds).toBeUndefined()
  for (const evaluatorIds of [[], ["first", "second"]]) {
    const parsed = playgroundSchema.parse({ ...base, nodes: [{ ...base.nodes[0], evaluatorIds }] })
    expect(parsed.nodes[0].evaluatorIds).toEqual(evaluatorIds)
  }
  expect(playgroundSchema.safeParse({ ...base, nodes: [{ ...base.nodes[0], evaluatorIds: Array(11).fill("score") }] }).success).toBe(false)
})
