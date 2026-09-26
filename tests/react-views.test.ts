import assert from "node:assert/strict"
import { describe, expect, test } from "bun:test"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { createReactViewService } from "@/src/server/tracer/react-views"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { withWorkspace } from "@/src/server/auth/context"
import {
  rankReactViews,
  reactViewInputSchema,
  viewCompatibility,
  type ReactView,
  type ViewRequirement,
} from "@/src/lib/tracer/react-views"
import { suggestViewRequirements } from "@/src/lib/tracer/react-view-suggestions"
import type { TraceDetail } from "@/src/lib/tracer/contracts"
const trace: TraceDetail = {
  id: "trace",
  name: "Example",
  operation: "answer",
  input: {},
  output: { answer: "Hello" },
  attributes: { "a/b.c": 42 },
  spans: [],
  scores: [],
  startedAt: "2026-09-25T00:00:00Z",
  endedAt: null,
  durationMs: null,
  status: "completed",
  sessionId: null,
}
const requirement: ViewRequirement = {
  path: "/output/answer",
  type: "string",
  required: true,
  nonEmpty: false,
}
const input = {
  name: "Answer",
  dataMode: "summary",
  description: "Renders an answer",
  code: "export default function View() { return null }",
  requirements: [requirement],
}

describe("React view compatibility", () => {
  test("distinguishes unknown, explicitly generic, required, optional, wrong types, empty arrays and escaped keys", () => {
    expect(
      viewCompatibility(
        [{ ...requirement, path: "/spans", type: "array" }],
        trace,
        ["spans"]
      ).state
    ).toBe("unknown")
    expect(viewCompatibility(null, trace).state).toBe("unknown")
    expect(viewCompatibility([], trace).state).toBe("met")
    expect(viewCompatibility([requirement], trace).state).toBe("met")
    expect(
      viewCompatibility([{ ...requirement, path: "/output/missing" }], trace)
        .reasons
    ).toEqual(["Missing /output/missing"])
    expect(
      viewCompatibility(
        [{ ...requirement, path: "/output/missing", required: false }],
        trace
      ).state
    ).toBe("met")
    expect(
      viewCompatibility([{ ...requirement, type: "array" }], trace).state
    ).toBe("missing")
    expect(
      viewCompatibility(
        [{ ...requirement, path: "/spans", type: "array", nonEmpty: true }],
        trace
      ).state
    ).toBe("missing")
    expect(
      viewCompatibility(
        [{ ...requirement, path: "/attributes/a~1b.c", type: "number" }],
        trace
      ).state
    ).toBe("met")
    expect(
      reactViewInputSchema.safeParse({
        ...input,
        requirements: [requirement, requirement],
      }).success
    ).toBe(false)
  })
  test("ranks actual requirements before origin context and never filters a view", () => {
    const view = (
      id: string,
      requirements: ViewRequirement[] | null,
      sameOperation = false
    ) =>
      ({
        id,
        name: id,
        requirements,
        origin: sameOperation ? { operation: trace.operation } : null,
      }) as ReactView
    const sorted = rankReactViews(
      [
        view("unknown", null, true),
        view("bad", [{ ...requirement, type: "array" }], true),
        view("different-operation", [requirement]),
        view("same-operation", [requirement], true),
      ],
      trace
    )
    expect(sorted.map((item) => item.view.id)).toEqual([
      "same-operation",
      "different-operation",
      "unknown",
      "bad",
    ])
  })
  test("suggests accessed fields only, handles bracket keys and optional reads without executing code", () => {
    const result = suggestViewRequirements(
      'globalThis.executed = true; export default ({trace}) => <div>{trace.output.answer}{trace.attributes["a/b.c"]}{trace.output?.citation}{trace.spans.map(x => x.name)}</div>',
      trace
    )
    expect(
      result.requirements.find((item) => item.path === requirement.path)
    ).toEqual(requirement)
    expect(
      result.requirements.find((item) => item.path === "/attributes/a~1b.c")
    ).toEqual({ ...requirement, path: "/attributes/a~1b.c", type: "number" })
    expect(
      result.requirements.find((item) => item.path === "/output/citation")
    ).toEqual({
      ...requirement,
      path: "/output/citation",
      type: "any",
      required: false,
    })
    expect(result.requirements.some((item) => item.path === "/spans")).toBe(
      true
    )
    expect((globalThis as { executed?: boolean }).executed).toBeUndefined()
  })
})

test("project views persist, retain provenance, paginate, isolate projects and reject stale writes/deletes", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const databases: ReturnType<typeof createTracerDatabase>[] = []
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const other = crypto.randomUUID()
    await pool.query(
      "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Other','other')",
      [other, target.organizationId]
    )
    await pool.query(
      "INSERT INTO traces(id,project_id,name,operation,status,started_at,group_type,group_name,group_version) VALUES('source',$1,'Original trace','answer','completed','2026-09-25T00:00:00Z','agent','Support','v1')",
      [target.projectId]
    )
    await pool.query(
      "INSERT INTO datasets(id,project_id,name,created_at,updated_at) VALUES('dataset',$1,'Examples',now(),now())",
      [target.projectId]
    )
    await pool.query(
      "INSERT INTO dataset_items(id,project_id,dataset_id,input_json,source_trace_id,created_at,updated_at) VALUES('row',$1,'dataset','{}','source',now(),now())",
      [target.projectId]
    )
    const service = (projectId: string) => {
      const database = createTracerDatabase(target.databaseUrl, { projectId })
      databases.push(database)
      return createReactViewService(database)
    }
    const first = service(target.projectId),
      second = service(target.projectId),
      foreign = service(other)
    await withWorkspace(
      {
        organizationId: target.organizationId,
        projectId: target.projectId,
        userId: target.ownerId,
        kind: "session",
        scopes: ["views:write", "traces:read", "datasets:read"],
      },
      async () => {
        const created = await run(
          first.create({ ...input, source: { kind: "trace", id: "source" } })
        )
        expect(created.dataMode).toBe("summary")
        expect(created.origin?.group?.version).toBe("v1")
        expect(created.author.name).toBe("Test owner")
        expect(await run(second.get(created.id))).toEqual(created)
        const dataset = await run(
          first.create({
            ...input,
            source: { kind: "dataset-item", id: "row" },
          })
        )
        expect(dataset.origin?.datasetName).toBe("Examples")
        expect(dataset.origin?.traceId).toBe("source")
        const page = await run(first.list({ limit: 1 }))
        expect(page.items).toHaveLength(1)
        expect(Object.hasOwn(page.items[0], "code")).toBe(false)
        expect(
          (await run(first.list({ cursor: page.nextCursor!, limit: 1 }))).items
        ).toHaveLength(1)
        const results = await Promise.allSettled([
          run(
            first.update(created.id, {
              ...input,
              name: "Changed",
              expectedRevision: 1,
            })
          ),
          run(second.update(created.id, { ...input, expectedRevision: 1 })),
        ])
        expect(
          results.filter((result) => result.status === "fulfilled")
        ).toHaveLength(1)
        expect((await run(first.get(created.id))).revision).toBe(2)
        await assert.rejects(
          run(first.delete(created.id, 1)),
          /changed in another browser/
        )
        expect((await run(foreign.list())).items).toHaveLength(0)
        await assert.rejects(run(foreign.get(created.id)), /was not found/)
        await assert.rejects(
          run(foreign.update(created.id, { ...input, expectedRevision: 2 })),
          /was not found/
        )
        await assert.rejects(
          run(foreign.delete(created.id, 2)),
          /was not found/
        )
        await pool.query("DELETE FROM dataset_items WHERE id='row'")
        await pool.query("DELETE FROM traces WHERE id='source'")
        expect((await run(second.get(created.id))).origin).toEqual(
          created.origin
        )
        expect((await run(second.get(dataset.id))).origin).toEqual(
          dataset.origin
        )
        await run(second.delete(created.id, 2))
        await assert.rejects(run(first.get(created.id)), /was not found/)
      }
    )
    await withWorkspace(
      {
        organizationId: target.organizationId,
        projectId: other,
        userId: target.ownerId,
        kind: "session",
        scopes: ["views:write", "datasets:read"],
      },
      async () => {
        await assert.rejects(
          run(
            foreign.create({
              ...input,
              source: { kind: "dataset-item", id: "row" },
            })
          ),
          /was not found/
        )
        await assert.rejects(
          run(
            foreign.create({
              ...input,
              source: { kind: "trace", id: "source" },
            })
          ),
          /Missing required permission/
        )
      }
    )
  } finally {
    await Promise.all(databases.map(closeTracerDatabase))
    await pool.end()
    await target.close()
  }
}, 30000)
