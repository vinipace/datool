import { createHash } from "node:crypto"
import { canonicalJson } from "../src/lib/tracer/resource-document"
import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"

test("native promotion and immutable snapshots retain more than 8 MiB of source evidence", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  try {
    const dataset = await run(service.createDataset({ name: "100 cases" }))
    for (let i = 0; i < 10; i++)
      await run(
        service.createDatasetItem(dataset.id, {
          id: `original-${i}`,
          input: { n: i },
          expectedOutput: { n: i },
        })
      )
    const selections: import("../src/lib/tracer/span-promotion").PromoteSpansInput["spans"] =
      []
    for (let i = 0; i < 90; i++) {
      const trace = await run(
        service.createTrace({
          name: `production ${i}`,
          status: "completed",
          attributes: { payload: "a".repeat(40_000) },
        })
      )
      const span = await run(
        service.createSpan(trace.id, {
          name: "extract",
          status: "completed",
          input: { n: i },
          output: { n: i },
          attributes: { payload: "b".repeat(40_000) },
        })
      )
      selections.push({
        copyObservedOutput: false,
        id: `promoted-${i.toString().padStart(2, "0")}`,
        traceId: trace.id,
        spanId: span.id,
        expectedOutput: { n: i },
      })
    }
    for (let i = 0; i < selections.length; i += 10) {
      const input = {
        datasetId: dataset.id,
        spans: selections.slice(i, i + 10),
      }
      const preview = await run(
        service.agent.promoteSpans({ ...input, preview: true })
      )
      await run(
        service.agent.promoteSpans({
          ...input,
          expectedEvidenceHash: preview.evidenceHash,
          preview: false,
        })
      )
    }
    const size = await db.execute(
      sql`select sum(octet_length(source_span_evidence_json)) as bytes from dataset_items`
    )
    expect(Number(size.rows[0].bytes)).toBeGreaterThan(8 * 1024 * 1024)
    const snapshot = await run(service.agent.createSnapshot(dataset.id))
    expect(snapshot.itemCount).toBe(100)
    expect((await run(service.agent.createSnapshot(dataset.id))).id).toBe(
      snapshot.id
    )
    let cursor: string | undefined
    const items = []
    do {
      const page = await run(
        service.agent.getSnapshot(dataset.id, snapshot.id, {
          limit: 100,
          cursor,
        })
      )
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        8 * 1024 * 1024
      )
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(items).toHaveLength(100)
    // Prove old clients' content hashes remain valid after the storage migration.
    const detail = await service.agent.snapshotArtifact(dataset.id, snapshot.id)
    const legacyHash = createHash("sha256")
      .update(
        canonicalJson({
          name: detail.name,
          description: detail.description,
          metadata: detail.metadata ?? {},
          fieldSchemas: detail.fieldSchemas ?? {},
          items: items.map((item) => ({
            id: item.id,
            datasetId: item.datasetId,
            input: item.input,
            expectedOutput: item.expectedOutput,
            metadata: item.metadata,
            sourceTraceId: item.sourceTraceId,
            sourceSpanId: item.sourceSpanId ?? null,
            sourceSpanEvidence: item.sourceSpanEvidence ?? null,
          })),
        })
      )
      .digest("hex")
    expect(snapshot.contentHash).toBe(legacyHash)
    const saved = items.find((item) => item.id === selections[0].id)!
    expect(saved.sourceSpanEvidence?.provenance?.trace.attributes.payload).toBe(
      "a".repeat(40_000)
    )
    expect(saved.sourceSpanEvidence?.attributes.payload).toBe(
      "b".repeat(40_000)
    )
    await run(service.patchSpan(selections[0].spanId, { output: "changed" }))
    await run(service.patchDatasetItem(saved.id, { expectedOutput: "changed" }))
    const frozen = await run(
      service.agent.getSnapshot(dataset.id, snapshot.id, { limit: 100 })
    )
    expect(
      frozen.items.find((item) => item.id === saved.id)?.sourceSpanEvidence
    ).toEqual(saved.sourceSpanEvidence)
    expect(
      frozen.items.find((item) => item.id === saved.id)?.expectedOutput
    ).toEqual(saved.expectedOutput)
  } finally {
    await closeTracerFixture(db)
  }
}, 60_000)
