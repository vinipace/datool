import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  DatasetDetail,
  DatasetItem,
  DatasetItemForEvaluation,
} from "@/src/lib/tracer/contracts"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { notFound, TracerError, validation } from "./errors"
import { assertRelationBytes } from "./read-size"
import { collectionSqlPage } from "./collection-sql"
import { fitEvalPage } from "./eval-read-page"
import { READ_MAX_BYTES } from "../semantic/read-budget"

export type SnapshotEvidenceRef = {
  datasetId: string
  snapshotId: string
  itemId: string
}
// Internal storage only; public reads and scorer execution hydrate the captured value.
export type StoredDatasetItem = DatasetItem & {
  sourceSpanEvidenceRef?: SnapshotEvidenceRef
}
export const liveItems = (project: string, id: string) =>
  sql`select id,dataset_id as "datasetId",input_json::jsonb as input,expected_output_json::jsonb as "expectedOutput",metadata_json::jsonb as metadata,source_trace_id as "sourceTraceId",source_span_id as "sourceSpanId",source_span_evidence_json::jsonb as "sourceSpanEvidence",(source_span_evidence_json::jsonb)->'output' as "observedOutput",created_at as "createdAt",updated_at as "updatedAt" from dataset_items where project_id=${project} and dataset_id=${id}`
export async function datasetHeader(db: TracerDatabase, id: string) {
  const project = getTracerProjectId(db)
  const rows = await db.execute(
    sql`select id,name,description,metadata_json::jsonb as metadata,field_schemas_json::jsonb as "fieldSchemas",created_at as "createdAt",updated_at as "updatedAt" from datasets where project_id=${project} and id=${id}`
  )
  if (!rows.rows[0]) throw notFound("Dataset", id)
  return rows.rows[0] as Omit<DatasetDetail, "items" | "itemCount">
}
/** Same canonical hash as legacy snapshots, streamed in ID order within the caller's transaction. */
export async function datasetHash(db: TracerDatabase, id: string) {
  const header = await datasetHeader(db, id)
  const hash = createHash("sha256")
  const fields = {
    name: header.name,
    description: header.description,
    metadata: header.metadata ?? {},
    fieldSchemas: header.fieldSchemas ?? {},
    items: [],
  }
  let count = 0
  for (const [index, key] of Object.keys(fields)
    .sort((a, b) => a.localeCompare(b))
    .entries()) {
    hash.update(`${index ? "," : "{"}${JSON.stringify(key)}:`)
    if (key !== "items") {
      hash.update(canonicalJson(fields[key as keyof typeof fields]))
      continue
    }
    hash.update("[")
    let cursor: string | undefined
    do {
      const page = await fitEvalPage(20, (limit) =>
        collectionSqlPage<DatasetItem>(
          db,
          liveItems(getTracerProjectId(db), id),
          { limit, cursor },
          "id",
          true
        )
      )
      for (const item of page.items) {
        hash.update(
          (count++ ? "," : "") +
            canonicalJson({
              id: item.id,
              datasetId: item.datasetId,
              input: item.input,
              expectedOutput: item.expectedOutput,
              metadata: item.metadata,
              sourceTraceId: item.sourceTraceId,
              sourceSpanId: item.sourceSpanId ?? null,
              sourceSpanEvidence: item.sourceSpanEvidence ?? null,
            })
        )
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    hash.update("]")
  }
  hash.update("}")
  return { header, itemCount: count, contentHash: hash.digest("hex") }
}
export async function writeSnapshot(
  db: TracerDatabase,
  datasetId: string,
  label?: string
) {
  const project = getTracerProjectId(db)
  const { header, itemCount, contentHash } = await datasetHash(db, datasetId)
  const id = `dsv_${randomUUID()}`
  const manifest = JSON.stringify({
    ...header,
    itemCount,
    items: [],
    storageVersion: 2,
  })
  if (Buffer.byteLength(manifest) > READ_MAX_BYTES)
    throw new TracerError(
      "READ_RESULT_TOO_LARGE",
      "Dataset settings exceed 8 MiB."
    )
  const inserted = await db.execute(
    sql`insert into dataset_snapshots(id,project_id,dataset_id,content_hash,label,item_count,content_json,created_at) values (${id},${project},${datasetId},${contentHash},${label ?? null},${itemCount},${manifest},${new Date().toISOString()}) on conflict(project_id,dataset_id,content_hash) do nothing returning id`
  )
  if (inserted.rows.length)
    await db.execute(
      sql`insert into dataset_snapshot_items(project_id,snapshot_id,id,content_json) select ${project},${id},item.id,to_jsonb(item) from (${liveItems(project, datasetId)}) item`
    )
  const result = await db.execute(
    sql`select id,dataset_id as "datasetId",content_hash as "contentHash",label,item_count as "itemCount",created_at as "createdAt" from dataset_snapshots where project_id=${project} and dataset_id=${datasetId} and content_hash=${contentHash}`
  )
  return result.rows[0] as {
    id: string
    datasetId: string
    contentHash: string
    label: string | null
    itemCount: number
    createdAt: string
  }
}
async function snapshotHeader(
  db: TracerDatabase,
  datasetId: string,
  versionId: string
) {
  const project = getTracerProjectId(db)
  const relation = sql`select content_json from dataset_snapshots where project_id=${project} and dataset_id=${datasetId} and id=${versionId}`
  await assertRelationBytes(db, relation)
  const result = await db.execute(relation)
  if (!result.rows[0]) throw notFound("Dataset snapshot", versionId)
  return JSON.parse(String(result.rows[0].content_json)) as DatasetDetail & {
    storageVersion?: number
  }
}
export async function snapshotPage(
  db: TracerDatabase,
  datasetId: string,
  versionId: string,
  page: { limit?: number; cursor?: string }
) {
  const { storageVersion, ...header } = await snapshotHeader(
    db,
    datasetId,
    versionId
  )
  return fitEvalPage(page.limit ?? 50, async (limit) => {
    if (storageVersion === 2) {
      const result = await collectionSqlPage<{ id: string; item: DatasetItem }>(
        db,
        sql`select id,content_json as item from dataset_snapshot_items where project_id=${getTracerProjectId(db)} and snapshot_id=${versionId}`,
        { ...page, limit },
        "id",
        true
      )
      return {
        ...header,
        versionId,
        items: result.items.map((row) => row.item),
        nextCursor: result.nextCursor,
      }
    }
    const start = page.cursor
      ? header.items.findIndex((item) => item.id === page.cursor) + 1
      : 0
    if (page.cursor && !start) throw validation("Invalid snapshot item cursor.")
    const items = header.items.slice(start, start + limit)
    return {
      ...header,
      versionId,
      items,
      nextCursor:
        start + items.length < header.items.length ? items.at(-1)!.id : null,
    }
  })
}
/** Bounded run manifest; large captured source evidence stays in immutable per-case storage. */
export async function snapshotManifest(
  db: TracerDatabase,
  datasetId: string,
  versionId: string
): Promise<DatasetDetail> {
  const { storageVersion, ...header } = await snapshotHeader(
    db,
    datasetId,
    versionId
  )
  if (storageVersion !== 2) return header
  const relation = sql`select content_json - 'sourceSpanEvidence' || case when content_json->'sourceSpanEvidence' <> 'null'::jsonb then jsonb_build_object('sourceSpanEvidenceRef',jsonb_build_object('datasetId',${datasetId}::text,'snapshotId',${versionId}::text,'itemId',id)) else '{}'::jsonb end as item from dataset_snapshot_items where project_id=${getTracerProjectId(db)} and snapshot_id=${versionId}`
  await assertRelationBytes(db, relation)
  const result = await db.execute(
    sql`select * from (${relation}) items order by item->>'id'`
  )
  return {
    ...header,
    items: result.rows.map((row) => row.item as StoredDatasetItem),
  }
}
export async function hydrateDatasetItem<T extends DatasetItemForEvaluation>(
  db: TracerDatabase,
  item: T
): Promise<T> {
  const { sourceSpanEvidenceRef: ref, ...rest } = item as T & {
    sourceSpanEvidenceRef?: SnapshotEvidenceRef
  }
  if (!ref) return item
  await snapshotHeader(db, ref.datasetId, ref.snapshotId)
  const relation = sql`select content_json->'sourceSpanEvidence' as evidence from dataset_snapshot_items where project_id=${getTracerProjectId(db)} and snapshot_id=${ref.snapshotId} and id=${ref.itemId}`
  await assertRelationBytes(db, relation)
  const row = (await db.execute(relation)).rows[0]
  if (!row) throw notFound("Snapshot case", ref.itemId)
  return { ...rest, sourceSpanEvidence: row.evidence } as T
}

/** A representative scorer preview reads just its selected case, regardless of dataset size. */
export async function datasetCase(
  db: TracerDatabase,
  datasetId: string,
  itemId?: string,
  versionId?: string
): Promise<DatasetItem | undefined> {
  if (versionId) {
    const header = await snapshotHeader(db, datasetId, versionId)
    if (header.storageVersion !== 2)
      return header.items.find((item) => item.id === itemId)
    if (!itemId) return undefined
    const relation = sql`select content_json as item from dataset_snapshot_items where project_id=${getTracerProjectId(db)} and snapshot_id=${versionId} and id=${itemId}`
    await assertRelationBytes(db, relation)
    return (await db.execute(relation)).rows[0]?.item as DatasetItem | undefined
  }
  await datasetHeader(db, datasetId)
  if (!itemId) return undefined
  const relation = sql`select * from (${liveItems(getTracerProjectId(db), datasetId)}) items where id=${itemId}`
  await assertRelationBytes(db, relation)
  return (await db.execute(relation)).rows[0] as DatasetItem | undefined
}
