import { rejects } from "node:assert/strict"
import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Pool } from "pg"
import { eq } from "drizzle-orm"
import { createTracerDatabase, closeTracerDatabase, type TracerDatabase } from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import { spans, traces } from "@/src/server/tracer/schema"
import { buildInspectorTree, flattenInspectorTree } from "@/components/tracer/trace-inspector-data"
import { toViewerTrace } from "@/components/tracer/trace-viewer-data"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace, type IsolatedPostgres } from "./helpers/postgres"

let target: IsolatedPostgres | undefined
const databases: TracerDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await closeTracerDatabase(database)
  await target?.close()
  target = undefined
})

test("complete lightweight trace survives large payloads, preserves depth, and scopes selected detail", async () => {
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema })
  databases.push(database)
  const service = new TracerService(database)
  const run = runTracerEffect
  const root = await run(service.createTrace({ name: "Large trace", operation: "workflow", status: "running" }))
  const startedAt = "2026-09-11T12:00:00.000Z"
  const endedAt = "2026-09-11T12:00:01.000Z"
  const payload = { secretPayload: "x".repeat(10_000) }
  const rows = Array.from({ length: 1205 }, (_, index) => ({
    id: `span-${index}`, projectId: target!.projectId, traceId: root.id,
    parentId: index ? `span-${index - 1}` : null,
    name: `Step ${index}`, kind: index ? "task" : "workflow",
    groupType: index ? null : "workflow", groupName: index ? null : "Big workflow",
    startedAt, endedAt, status: index === 1204 ? "errored" : "completed",
    inputJson: JSON.stringify({ index }), outputJson: JSON.stringify(payload),
    attributesJson: JSON.stringify({ privateMetadata: payload, "usage.input_tokens": index, "cost.usd": 0.001 }),
  }))
  for (let index = 0; index < rows.length; index += 100) await database.insert(spans).values(rows.slice(index, index + 100))
  const overview = await run(service.getTraceOverview(root.id))
  expect(overview.spans).toHaveLength(1205)
  expect(overview.spanStats?.spanCount).toBe(1205)
  expect(overview.spanStats?.errorCount).toBe(1)
  expect(overview.spans[0].group?.name).toBe("Big workflow")
  const treeRows = flattenInspectorTree(buildInspectorTree(overview), new Set())
  expect(treeRows.at(-1)?.node.depth).toBe(1204)
  expect(toViewerTrace(overview).spans).toHaveLength(1205)
  const encoded = JSON.stringify(overview)
  expect(encoded.includes('"input":')).toBe(false)
  expect(encoded.includes('"output":')).toBe(false)
  expect(encoded.includes("secretPayload")).toBe(false)
  expect(encoded.includes("privateMetadata")).toBe(false)
  expect(Buffer.byteLength(encoded) < 1_000_000).toBe(true)
  expect(overview.spans.find(span => span.id === "span-1204")?.attributes["usage.input_tokens"]).toBe(1204)

  const opening = await run(service.getTraceOverview(root.id, true))
  expect(opening.rootDetail?.id).toBe(buildInspectorTree(opening).id!)
  expect(opening.rootDetail?.output).toEqual(payload)
  expect(JSON.stringify(opening.spans).includes("secretPayload")).toBe(false)
  expect(overview.rootDetail).toBeUndefined()

  const selected = await run(service.getTraceSpan(root.id, "span-1204"))
  expect(selected.output).toEqual(payload)
  expect(selected.attributes.privateMetadata).toEqual(payload)
  // Existing path endpoint would reject this depth; selected detail has no ancestry limit.
  expect(selected.parentId).toBe("span-1203")
  await rejects(run(service.getTraceArtifact(root.id)), /8 MiB/)
  await rejects(run(service.getTraceSpan("wrong-trace", "span-1204")), /not found/)

  const otherDatabase = createTracerDatabase(target.databaseUrl, { projectId: randomUUID(), schema: target.schema })
  databases.push(otherDatabase)
  const other = new TracerService(otherDatabase)
  await rejects(run(other.getTraceOverview(root.id)), /not found/)
  await rejects(run(other.getTraceSpan(root.id, "span-1204")), /not found/)
  await rejects(run(other.getTracePayload(root.id)), /not found/)

  await database.insert(spans).values({ ...rows[0], id: "late-span", parentId: "span-1204" })
  await database.update(traces).set({ status: "completed", endedAt }).where(eq(traces.id, root.id))
  const refreshed = await run(service.getTraceOverview(root.id))
  expect(refreshed.spans).toHaveLength(1206)
  expect(refreshed.status).toBe("completed")
  expect((await run(service.getTracePayload(root.id))).id).toBe(root.id)
  const empty = await run(service.createTrace({ name: "Empty", operation: "test" }))
  expect((await run(service.getTraceOverview(empty.id))).spans).toEqual([])
  expect((await run(service.getTraceOverview(empty.id, true))).rootDetail?.id).toBe(empty.id)
  await database.insert(spans).values({ ...rows[0], id: "second-root" })
  const multipleRoots = await run(service.getTraceOverview(root.id, true))
  expect(buildInspectorTree(multipleRoots).id).toBe(null)
  expect(multipleRoots.rootDetail?.id).toBe(root.id)
}, 30_000)

test("trace navigation and lazy payload reads work before the independent span groups migration", async () => {
  target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    const directory = join(process.cwd(), "migrations")
    const files = (await readdir(directory)).filter(file => file.endsWith(".sql") && file < "0009_").sort()
    for (const file of files) await pool.query(await readFile(join(directory, file), "utf8"))
    await seedTestWorkspace(target)
    await pool.query(`INSERT INTO traces (id, project_id, name, operation, status, started_at, input_json)
      VALUES ('legacy-trace', $1, 'Legacy trace', 'workflow', 'completed', '2026-09-11T12:00:00Z', '{"prompt":"trace payload"}')`, [target.projectId])
    await pool.query(`INSERT INTO spans (id, project_id, trace_id, parent_id, name, kind, group_name,
      status, started_at, input_json, output_json, attributes_json)
      SELECT 'legacy-' || n, $1, 'legacy-trace', CASE WHEN n > 0 THEN 'legacy-' || (n - 1) END,
        'Step ' || n, CASE WHEN n = 0 THEN 'workflow' ELSE 'task' END,
        CASE WHEN n = 0 THEN 'Legacy workflow' END, 'completed', '2026-09-11T12:00:00Z',
        jsonb_build_object('index', n), '{"result":"selected payload"}', '{"private":"metadata"}'
      FROM generate_series(0, 74) AS n`, [target.projectId])
    const database = createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema })
    databases.push(database)
    const service = new TracerService(database)
    const overview = await runTracerEffect(service.getTraceOverview("legacy-trace"))
    expect(overview.spans).toHaveLength(75)
    expect(overview.spans.find(span => span.id === "legacy-0")?.group).toEqual({ type: "workflow", name: "Legacy workflow", version: null })
    expect(overview.spans.find(span => span.id === "legacy-74")?.group).toBe(null)
    expect(JSON.stringify(overview).includes("selected payload")).toBe(false)
    const opening = await runTracerEffect(service.getTraceOverview("legacy-trace", true))
    expect(opening.rootDetail?.id).toBe("legacy-0")
    expect(opening.rootDetail?.output).toEqual({ result: "selected payload" })
    const selected = await runTracerEffect(service.getTraceSpan("legacy-trace", "legacy-74"))
    expect(selected.input).toEqual({ index: 74 })
    expect(selected.output).toEqual({ result: "selected payload" })
    expect(selected.attributes).toEqual({ private: "metadata" })
    const group = await runTracerEffect(service.getTraceSpan("legacy-trace", "legacy-0"))
    expect(group.group?.type).toBe("workflow")
    const page = await runTracerEffect(service.listTraceSpans("legacy-trace", { limit: 200 }))
    expect(page.items).toHaveLength(75)
    expect(page.items.find(span => span.id === "legacy-0")?.group).toEqual(group.group)
    expect(page.items.find(span => span.id === "legacy-74")?.output).toEqual(selected.output)
    expect((await runTracerEffect(service.getTracePayload("legacy-trace"))).input).toEqual({ prompt: "trace payload" })
    const column = await pool.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'spans'::regclass AND attname = 'group_type' AND NOT attisdropped`)
    expect(column.rows).toHaveLength(0)
  } finally {
    await pool.end()
  }
}, 30_000)
