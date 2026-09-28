import { expect, test } from "bun:test"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"
import { createTracerDatabase, closeTracerDatabase } from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { DATASET_ITEM_READ_MAX_BYTES } from "../src/lib/tracer/dataset-payload"
import { handleMcp } from "../src/server/mcp/http"

test("one item above the page budget remains browsable, filterable and individually readable without truncation", async () => {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, { projectId: target.projectId, schema: target.schema })
  const foreign = createTracerDatabase(target.databaseUrl, { projectId: "another-project", schema: target.schema })
  const service = new TracerService(db)
  try {
    const dataset = await run(service.createDataset({ name: "Large item regression" }))
    const input = { marker: "needle", text: "é".repeat(5 * 1024 * 1024) }
    const item = await run(service.createDatasetItem(dataset.id, { input, expectedOutput: { ok: true }, metadata: { reviewed: true } }))
    const header = await run(service.getDataset(dataset.id, { includeItems: false }))
    expect(header.itemCount).toBe(1)
    expect(header.items).toEqual([])
    const preview = await run(service.listDatasetItems(dataset.id, { preview: true, includeTotal: true, filter: 'input.marker = "needle"' }))
    expect(preview.total).toBe(1)
    expect(preview.items[0].input).toBeNull()
    expect(preview.items[0].omittedFields?.input?.bytes).toBeGreaterThan(8 * 1024 * 1024)
    expect(preview.items[0].omittedFields?.input?.preview).toBe(JSON.stringify(input).slice(0, 128))
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(5000)
    expect(preview.items[0].expectedOutput).toEqual({ ok: true })
    expect(preview.items[0].metadata).toEqual({ reviewed: true })
    const complete = await run(service.getDatasetItem(item.id))
    expect(complete.input).toEqual(input)
    expect("omittedFields" in complete).toBe(false)
    expect(await run(new TracerService(foreign).getDatasetItem(item.id)).catch(error => error)).toMatchObject({ code: "NOT_FOUND" })
    const updated = await run(service.patchDatasetItem(item.id, { metadata: { reviewed: false }, expectedVersionId: item.versionId }))
    expect(updated.input).toEqual(input)
    expect(updated.metadata).toEqual({ reviewed: false })
    const tooLarge = await run(service.createDatasetItem(dataset.id, { input: "x".repeat(DATASET_ITEM_READ_MAX_BYTES + 1) }))
    expect(await run(service.getDatasetItem(tooLarge.id)).catch(error => error)).toMatchObject({ code: "READ_RESULT_TOO_LARGE" })
    const page = await run(service.listDatasetItems(dataset.id, { preview: true, limit: 1 }))
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).not.toBeNull()
    const next = await run(service.listDatasetItems(dataset.id, { preview: true, limit: 1, cursor: page.nextCursor }))
    expect(next.items[0].id).toBe(tooLarge.id)
    expect(next.nextCursor).toBeNull()
    const trace = await run(service.createTrace({ name: "Captured evidence", status: "completed" }))
    const span = await run(service.createSpan(trace.id, { name: "Large output", status: "completed", output: "result".repeat(5000) }))
    const captured = await run(service.createDatasetItem(dataset.id, { input: {}, sourceTraceId: trace.id, sourceSpanId: span.id }))
    const capturedPreview = await run(service.listDatasetItems(dataset.id, { preview: true, filter: `id = "${captured.id}"` }))
    expect(capturedPreview.items[0].omittedFields?.sourceSpanEvidence?.bytes).toBeGreaterThan(16 * 1024)
    expect(capturedPreview.items[0].omittedFields?.sourceSpanEvidence?.preview).toHaveLength(128)
    expect(capturedPreview.items[0].sourceSpanEvidence).toBeNull()
    expect(capturedPreview.items[0].observedOutput).toBeNull()
    expect((await run(service.getDatasetItem(captured.id))).sourceSpanEvidence).toEqual(captured.sourceSpanEvidence)
    const mcpUrl = "https://datool.example/api/mcp"
    const dependencies = {
      config: () => ({ resource: mcpUrl, issuer: "https://datool.example", jwksUrl: "https://datool.example/jwks", origins: [] }),
      authenticate: async () => ({ subject: "test", organizationId: target.organizationId, projectId: target.projectId, scopes: ["datasets:read", "datasets:write"] }),
      service: async () => service,
    }
    const largeInput = "x".repeat(2 * 1024 * 1024)
    const call = (message: unknown) => handleMcp(new Request(mcpUrl, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(message),
    }), dependencies)
    const created = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_dataset_item", arguments: { datasetId: dataset.id, item: { input: largeInput } } } })
    expect(created.status).toBe(200)
    const createdBody = await created.json()
    expect(createdBody.result.isError).not.toBe(true)
    const oversizedOther = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", padding: largeInput })
    expect(oversizedOther.status).toBe(413)
  } finally {
    await closeTracerDatabase(foreign)
    await closeTracerDatabase(db)
    await target.close()
  }
}, 60_000)
