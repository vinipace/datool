import { validateDatasetSchemas } from "./dataset-fields"
import { randomUUID } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import type {
  CreateDatasetInput,
  PatchDatasetInput,
} from "@/src/lib/tracer/contracts"
import {
  datasetLeafName,
  datasetPath,
  type CreateLibraryEntry,
  type DatasetLibraryEntry,
  type MoveLibraryEntry,
} from "@/src/lib/tracer/dataset-library"
import { collectionSqlPage } from "./collection-sql"
import {
  getTracerProjectId,
  scopedTracerTransaction,
  type TracerDatabase,
} from "./db"
import { datasetFolders, datasets } from "./schema"
import { notFound, TracerError, validation } from "./errors"

function checkedPath(name: string) {
  const result = datasetPath.safeParse(name)
  if (!result.success) throw validation(result.error.issues[0].message)
  return result.data
}

/** Serialize hierarchy writes, including empty roots and reciprocal folder moves. */
export async function lockDatasetLibrary(database: TracerDatabase) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext('dataset-library'), hashtext(${getTracerProjectId(database)}))`
  )
}

async function write<T>(
  database: TracerDatabase,
  work: (tx: TracerDatabase) => Promise<T>
) {
  return database.transaction(async (tx) => {
    const scoped = scopedTracerTransaction(database, tx)
    await lockDatasetLibrary(scoped)
    return work(scoped)
  })
}

async function folderName(database: TracerDatabase, id: string | null) {
  if (id === null) return ""
  const [folder] = await database
    .select()
    .from(datasetFolders)
    .where(
      and(
        eq(datasetFolders.projectId, getTracerProjectId(database)),
        eq(datasetFolders.id, id)
      )
    )
    .limit(1)
  if (!folder) throw notFound("Folder", id)
  return folder.name
}

async function assertAvailable(
  database: TracerDatabase,
  name: string,
  exceptId?: string
) {
  const projectId = getTracerProjectId(database)
  const result =
    await database.execute(sql`select id from datasets where project_id=${projectId} and name=${name}
    union all select id from dataset_folders where project_id=${projectId} and name=${name}`)
  if (result.rows.some((row) => row.id !== exceptId))
    throw new TracerError(
      "CONFLICT",
      `“${name}” already exists. Choose a different name or folder.`
    )
}

/** Caller holds the hierarchy lock in a transaction. Resource imports use this too. */
export async function ensureDatasetParents(
  database: TracerDatabase,
  rawName: string
) {
  const name = checkedPath(rawName)
  const projectId = getTracerProjectId(database)
  const parts = name.split("/")
  const [folderAtPath] = await database
    .select({ id: datasetFolders.id })
    .from(datasetFolders)
    .where(
      and(
        eq(datasetFolders.projectId, projectId),
        eq(datasetFolders.name, name)
      )
    )
    .limit(1)
  if (folderAtPath)
    throw new TracerError("CONFLICT", `“${name}” is already a folder.`)
  for (let index = 1; index < parts.length; index++) {
    const path = parts.slice(0, index).join("/")
    const [existing] = await database
      .select({ id: datasetFolders.id })
      .from(datasetFolders)
      .where(
        and(
          eq(datasetFolders.projectId, projectId),
          eq(datasetFolders.name, path)
        )
      )
      .limit(1)
    if (existing) continue
    await assertAvailable(database, path)
    const timestamp = new Date().toISOString()
    await database.insert(datasetFolders).values({
      id: `df_${randomUUID()}`,
      projectId,
      name: path,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }
  return name
}

async function insertDatasetInLibrary(
  database: TracerDatabase,
  input: CreateDatasetInput,
  folderId: string | null = null
) {
  const tx = database
  const parent = await folderName(tx, folderId)
  const name = await ensureDatasetParents(
    tx,
    parent ? `${parent}/${input.name}` : input.name
  )
  await assertAvailable(tx, name)
  const timestamp = new Date().toISOString()
  const [row] = await tx
    .insert(datasets)
    .values({
      id: input.id ?? `dset_${randomUUID()}`,
      projectId: getTracerProjectId(tx),
      name,
      description: input.description ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning()
  return {
    id: row.id,
    versionId: row.versionId,
    revision: row.revision,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itemCount: 0,
  }
}

export async function createDatasetInLibrary(
  database: TracerDatabase,
  input: CreateDatasetInput,
  folderId: string | null = null
) {
  return write(database, (tx) => insertDatasetInLibrary(tx, input, folderId))
}

async function libraryParents(
  database: TracerDatabase,
  name: string
): Promise<DatasetLibraryEntry[]> {
  const parts = name.split("/")
  const paths = parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"))
  if (!paths.length) return []
  const folders = await database
    .select()
    .from(datasetFolders)
    .where(
      and(
        eq(datasetFolders.projectId, getTracerProjectId(database)),
        inArray(datasetFolders.name, paths)
      )
    )
  return folders.map((folder) => ({
    ...folder,
    kind: "folder",
    description: null,
    itemCount: null,
  }))
}

export async function createDatasetLibraryEntry(
  database: TracerDatabase,
  input: CreateLibraryEntry
) {
  return write(database, async (tx) => {
    if (input.kind === "dataset") {
      const entry = await insertDatasetInLibrary(
        tx,
        { name: input.name, description: input.description },
        input.folderId
      )
      return {
        ...entry,
        kind: "dataset" as const,
        folders: await libraryParents(tx, entry.name),
      }
    }
    const parent = await folderName(tx, input.folderId)
    const name = await ensureDatasetParents(
      tx,
      parent ? `${parent}/${input.name}` : input.name
    )
    await assertAvailable(tx, name)
    const timestamp = new Date().toISOString()
    const [row] = await tx
      .insert(datasetFolders)
      .values({
        id: `df_${randomUUID()}`,
        projectId: getTracerProjectId(tx),
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
    return {
      ...row,
      folders: await libraryParents(tx, row.name),
      kind: "folder" as const,
      description: null,
      itemCount: null,
    }
  })
}

export async function listDatasetLibrary(
  database: TracerDatabase,
  options: {
    scope?: "tree"
    folderId?: string | null
    filter?: string | null
    cursor?: string | null
    limit?: number
  }
) {
  if (options.scope === "tree" && (options.folderId || options.filter))
    throw validation(
      "Tree reads cannot be scoped to a folder or search filter."
    )
  const projectId = getTracerProjectId(database)
  const parent =
    options.scope === "tree"
      ? ""
      : await folderName(database, options.folderId ?? null)
  const prefix = parent ? `${parent}/` : ""
  // Tree reads include every depth. The API also supports project-wide search
  // and direct-child pages for consumers that only need part of the library.
  const predicate =
    options.scope === "tree"
      ? sql`true`
      : options.filter?.trim()
        ? sql`strpos(lower(name), lower(${options.filter.trim()})) > 0`
        : sql`regexp_replace(name, '[^/]+$', '') = ${prefix}`
  const datasetPredicate = options.filter?.trim()
    ? sql`strpos(lower(name || ' ' || coalesce(description,'')), lower(${options.filter.trim()})) > 0`
    : predicate
  return collectionSqlPage<DatasetLibraryEntry>(
    database,
    sql`
    select id, 'folder'::text as kind, name, null::text as description, null::integer as "itemCount", created_at as "createdAt", updated_at as "updatedAt"
    from dataset_folders where project_id=${projectId} and ${predicate}
    union all
    select id, 'dataset'::text as kind, name, description,
    (select count(*)::integer from dataset_items i where i.project_id=${projectId} and i.dataset_id=d.id) as "itemCount",
    created_at as "createdAt", updated_at as "updatedAt"
    from datasets d where project_id=${projectId} and ${datasetPredicate}
  `,
    options,
    options.scope === "tree" ? "id" : "name",
    true
  )
}

export async function moveDatasetLibraryEntry(
  database: TracerDatabase,
  input: MoveLibraryEntry
) {
  return write(database, async (tx) => {
    const projectId = getTracerProjectId(tx)
    const table = input.kind === "folder" ? datasetFolders : datasets
    const [entry] = await tx
      .select()
      .from(table)
      .where(and(eq(table.projectId, projectId), eq(table.id, input.id)))
      .limit(1)
    if (!entry) throw notFound(input.kind, input.id)
    const parent = await folderName(tx, input.folderId)
    if (
      input.kind === "folder" &&
      (parent === entry.name || parent.startsWith(`${entry.name}/`))
    )
      throw validation(
        "A folder cannot be moved into itself or one of its descendants."
      )
    const name = checkedPath(
      parent
        ? `${parent}/${datasetLeafName(entry.name)}`
        : datasetLeafName(entry.name)
    )
    if (name === entry.name) return { id: entry.id, name }
    await assertAvailable(tx, name, entry.id)
    const updatedAt = new Date().toISOString()
    if (input.kind === "folder") {
      // Literal prefix comparisons keep %, _ and other path characters safe.
      const prefix = `${entry.name}/`
      const tooLong = await tx.execute(sql`select 1 from (
        select name from datasets where project_id=${projectId} and starts_with(name,${prefix})
        union all select name from dataset_folders where project_id=${projectId} and starts_with(name,${prefix})
      ) descendants where length(name) - char_length(${entry.name}::text) + char_length(${name}::text) > 200 limit 1`)
      if (tooLong.rows.length)
        throw validation(
          "This move would make a descendant path longer than 200 characters."
        )
      await tx
        .update(datasets)
        .set({
          name: sql`${name} || substring(${datasets.name} from char_length(${entry.name}::text) + 1)`,
          updatedAt,
        })
        .where(
          and(
            eq(datasets.projectId, projectId),
            sql`starts_with(${datasets.name},${prefix})`
          )
        )
      await tx
        .update(datasetFolders)
        .set({
          name: sql`${name} || substring(${datasetFolders.name} from char_length(${entry.name}::text) + 1)`,
          updatedAt,
        })
        .where(
          and(
            eq(datasetFolders.projectId, projectId),
            sql`starts_with(${datasetFolders.name},${prefix})`
          )
        )
    }
    await tx
      .update(table)
      .set({ name, updatedAt })
      .where(and(eq(table.projectId, projectId), eq(table.id, entry.id)))
    return { id: entry.id, name }
  })
}

export async function patchDatasetInLibrary(
  database: TracerDatabase,
  id: string,
  input: PatchDatasetInput
) {
  return write(database, async (tx) => {
    const projectId = getTracerProjectId(tx)
    const [current] = await tx
      .select()
      .from(datasets)
      .where(and(eq(datasets.projectId, projectId), eq(datasets.id, id)))
      .limit(1)
      .for("update")
    if (!current) throw notFound("Dataset", id)
    const fieldSchemas = { ...JSON.parse(current.fieldSchemasJson), ...input.fieldSchemas }
    validateDatasetSchemas(fieldSchemas)
    const name =
      input.name === undefined
        ? current.name
        : await ensureDatasetParents(tx, input.name)
    if (input.name !== undefined) await assertAvailable(tx, name, id)
    const [row] = await tx
      .update(datasets)
      .set({
        name,
        metadataJson: input.metadata === undefined ? current.metadataJson : JSON.stringify(input.metadata),
        fieldSchemasJson: JSON.stringify(fieldSchemas),
        description:
          input.description === undefined
            ? current.description
            : input.description,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(datasets.projectId, projectId), eq(datasets.id, id)))
      .returning()
    const count = await tx.execute(
      sql`select count(*)::integer as count from dataset_items where project_id=${projectId} and dataset_id=${id}`
    )
    return {
      id: row.id,
      versionId: row.versionId,
      revision: row.revision,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      itemCount: Number(count.rows[0].count),
      metadata: JSON.parse(row.metadataJson),
      fieldSchemas: JSON.parse(row.fieldSchemasJson),
    }
  })
}
