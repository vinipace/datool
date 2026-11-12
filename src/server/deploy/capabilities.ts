import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { z } from "zod"
import type { BuildContext } from "../build/context"
import { assertBuildProject } from "../build/context"
import { publicHttpRequest } from "../build/http"
import { objectStorage } from "../build/storage/objects"
import {
  storageConnection,
  storageCredentials,
} from "../build/storage/connections"
import { runAgentSandboxCommand } from "../build/sandbox-runtime"
import {
  agentSandboxSchema,
  sandboxCommandSchema,
  type AgentSandboxProvider,
} from "@/src/lib/build/sandbox"
import { brainSearchSchema } from "@/src/lib/deploy/contracts"
import { TracerError } from "../tracer/errors"

const key = z.string().min(1).max(240)
const collection = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const documentKey = z.object({ collection, key }).strict()
const page = z.object({
  cursor: key.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
const conflict = () =>
  new TracerError(
    "CONFLICT",
    "The stored revision changed. Read it again before writing."
  )

export async function searchBrain(
  context: BuildContext,
  deploymentId: string,
  raw: unknown
) {
  const { query, limit } = brainSearchSchema.parse(raw)
  const result = await context.database.execute<{
    path: string
    title: string
    text: string
  }>(sql`
    SELECT source_path AS path,title,content AS text FROM project_brain_chunks
    WHERE project_id=${context.projectId} AND deployment_id=${deploymentId}::uuid
      AND search_vector @@ plainto_tsquery('simple',${query})
    ORDER BY ts_rank(search_vector,plainto_tsquery('simple',${query})) DESC,source_path,ordinal LIMIT ${limit}
  `)
  return { items: result.rows }
}

async function bucketStore(context: BuildContext) {
  const rows = await context.database.execute<{
    storage_connection_id: string | null
  }>(
    sql`SELECT storage_connection_id FROM project_deployment_state WHERE project_id=${context.projectId}`
  )
  const connectionId = rows.rows[0]?.storage_connection_id
  const project = createHash("sha256").update(context.projectId).digest("hex")
  if (connectionId) {
    const connection = await storageConnection(context, connectionId)
    const storage = objectStorage(
      connection.config_json,
      storageCredentials(context, connection)
    )
    const prefix = [connection.config_json.prefix, "project-buckets", project]
      .filter(Boolean)
      .join("/")
    return {
      get: (id: string) => storage.get(`${prefix}/${id}`),
      put: (id: string, bytes: Buffer) => storage.put(`${prefix}/${id}`, bytes),
      remove: (id: string) => storage.remove(`${prefix}/${id}`),
      close: storage.close,
    }
  }
  const root = join(
    process.env.DATOOL_DATA_DIR ?? join(process.cwd(), ".data"),
    "project-buckets",
    project
  )
  return {
    get: (id: string) => readFile(join(root, id)),
    async put(id: string, bytes: Buffer) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await writeFile(join(root, id), bytes, { mode: 0o600, flag: "wx" })
    },
    remove: (id: string) => rm(join(root, id), { force: true }),
    close() {},
  }
}

export function deploymentCapabilities(
  context: BuildContext,
  options: {
    deploymentId?: string
    sandbox: AgentSandboxProvider
    readOnly?: boolean
    signal: AbortSignal
  }
) {
  return async (raw: unknown): Promise<unknown> => {
    options.signal.throwIfAborted()
    const { op, input } = z
      .object({ op: z.string(), input: z.unknown() })
      .strict()
      .parse(raw)
    await assertBuildProject(context)
    if (
      options.readOnly &&
      ![
        "db.get",
        "db.list",
        "bucket.get",
        "bucket.list",
        "brain.search",
        "fetch",
      ].includes(op)
    )
      throw new Error(
        "Source collectors and module inspection cannot modify project resources."
      )
    if (op === "db.get") {
      const value = documentKey.parse(input)
      const rows = await context.database.execute(
        sql`SELECT value,revision FROM project_documents WHERE project_id=${context.projectId} AND collection=${value.collection} AND key=${value.key}`
      )
      return rows.rows[0] ?? null
    }
    if (op === "db.set") {
      const value = documentKey
        .extend({
          value: z.json(),
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict()
        .parse(input)
      const json = JSON.stringify(value.value)
      if (Buffer.byteLength(json) > 256 * 1024)
        throw new Error("A document cannot exceed 256 KiB.")
      const rows =
        value.expectedRevision === 0
          ? await context.database.execute(
              sql`INSERT INTO project_documents(project_id,collection,key,value) VALUES(${context.projectId},${value.collection},${value.key},${json}::jsonb) ON CONFLICT DO NOTHING RETURNING revision`
            )
          : value.expectedRevision !== undefined
            ? await context.database.execute(
                sql`UPDATE project_documents SET value=${json}::jsonb,revision=revision+1,updated_at=now() WHERE project_id=${context.projectId} AND collection=${value.collection} AND key=${value.key} AND revision=${value.expectedRevision} RETURNING revision`
              )
            : await context.database.execute(
                sql`INSERT INTO project_documents(project_id,collection,key,value) VALUES(${context.projectId},${value.collection},${value.key},${json}::jsonb) ON CONFLICT(project_id,collection,key) DO UPDATE SET value=excluded.value,revision=project_documents.revision+1,updated_at=now() RETURNING revision`
              )
      if (!rows.rows.length) throw conflict()
      return rows.rows[0]
    }
    if (op === "db.delete") {
      const value = documentKey
        .extend({ expectedRevision: z.number().int().min(1).optional() })
        .strict()
        .parse(input)
      const rows = await context.database.execute(
        sql`DELETE FROM project_documents WHERE project_id=${context.projectId} AND collection=${value.collection} AND key=${value.key} ${value.expectedRevision === undefined ? sql`` : sql`AND revision=${value.expectedRevision}`} RETURNING key`
      )
      if (!rows.rows.length && value.expectedRevision !== undefined)
        throw conflict()
      return { deleted: rows.rows.length > 0 }
    }
    if (op === "db.list") {
      const value = page
        .extend({
          collection,
          where: z.record(z.string().max(100), z.json()).optional(),
        })
        .strict()
        .parse(input)
      const rows = await context.database.execute<{
        key: string
        value: unknown
        revision: number
      }>(
        sql`SELECT key,value,revision FROM project_documents WHERE project_id=${context.projectId} AND collection=${value.collection} ${value.cursor ? sql`AND key>${value.cursor}` : sql``} ${value.where ? sql`AND value @> ${JSON.stringify(value.where)}::jsonb` : sql``} ORDER BY key LIMIT ${value.limit + 1}`
      )
      const items = [] as typeof rows.rows
      let bytes = 0
      for (const row of rows.rows.slice(0, value.limit)) {
        const size = Buffer.byteLength(JSON.stringify(row))
        if (bytes + size > 1024 * 1024) break
        bytes += size
        items.push(row)
      }
      return {
        items,
        nextCursor: rows.rows.length > items.length ? items.at(-1)!.key : null,
      }
    }
    if (op === "bucket.list") {
      const value = page
        .extend({ prefix: z.string().max(240).default("") })
        .strict()
        .parse(input)
      const rows = await context.database.execute<{ key: string }>(
        sql`SELECT key,size,content_type AS "contentType" FROM project_bucket_objects WHERE project_id=${context.projectId} AND starts_with(key,${value.prefix}) ${value.cursor ? sql`AND key>${value.cursor}` : sql``} ORDER BY key LIMIT ${value.limit + 1}`
      )
      const items = rows.rows.slice(0, value.limit)
      return {
        items,
        nextCursor: rows.rows.length > value.limit ? items.at(-1)!.key : null,
      }
    }
    if (["bucket.get", "bucket.put", "bucket.delete"].includes(op)) {
      const value = (
        op === "bucket.put"
          ? z.object({
              key,
              data: z
                .string()
                .max(1398104)
                .regex(
                  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
                ),
              contentType: z.string().min(1).max(160),
            })
          : z.object({ key })
      )
        .strict()
        .parse(input)
      const store = await bucketStore(context)
      try {
        if (op === "bucket.get") {
          const rows = await context.database.execute<{
            object_id: string
            content_type: string
            size: number
          }>(
            sql`SELECT object_id,content_type,size FROM project_bucket_objects WHERE project_id=${context.projectId} AND key=${value.key}`
          )
          const object = rows.rows[0]
          return object
            ? {
                data: (await store.get(object.object_id)).toString("base64"),
                contentType: object.content_type,
                size: object.size,
              }
            : null
        }
        if (op === "bucket.delete") {
          const rows = await context.database.execute<{ object_id: string }>(
            sql`DELETE FROM project_bucket_objects WHERE project_id=${context.projectId} AND key=${value.key} RETURNING object_id`
          )
          if (rows.rows[0]) await store.remove(rows.rows[0].object_id)
          return { deleted: rows.rows.length > 0 }
        }
        const upload = z
          .object({ key, data: z.string(), contentType: z.string() })
          .parse(value)
        const bytes = Buffer.from(upload.data, "base64"),
          id = randomUUID()
        if (bytes.length > 1024 * 1024)
          throw new Error("Bucket transfers are limited to 1 MiB.")
        await store.put(id, bytes)
        try {
          await context.database.execute(
            sql`INSERT INTO project_bucket_objects(project_id,key,object_id,size,content_type) VALUES(${context.projectId},${value.key},${id}::uuid,${bytes.length},${upload.contentType}) ON CONFLICT(project_id,key) DO UPDATE SET object_id=excluded.object_id,size=excluded.size,content_type=excluded.content_type,updated_at=now()`
          )
        } catch (error) {
          await store.remove(id).catch(() => undefined)
          throw error
        }
        return { key: value.key, size: bytes.length }
      } finally {
        store.close()
      }
    }
    if (op === "brain.search")
      return options.deploymentId
        ? searchBrain(context, options.deploymentId, input)
        : { items: [] }
    if (op === "sandbox.run") {
      const command = sandboxCommandSchema.parse(input)
      return runAgentSandboxCommand(
        context,
        agentSandboxSchema.parse({ enabled: true, provider: options.sandbox }),
        command,
        options.signal
      )
    }
    if (op === "fetch") {
      const value = z
        .object({
          url: z.string().max(4096),
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
            .default("GET"),
          headers: z
            .record(z.string().max(200), z.string().max(4000))
            .optional(),
          body: z
            .string()
            .max(256 * 1024)
            .optional(),
        })
        .strict()
        .parse(input)
      if (options.readOnly && !["GET", "HEAD"].includes(value.method))
        throw new Error("Source collectors can only fetch with GET or HEAD.")
      const result = await publicHttpRequest(value.url, {
        ...value,
        maxResponseBytes: 1024 * 1024,
        timeoutMs: 15_000,
        signal: options.signal,
      })
      return {
        status: result.status,
        headers: Object.fromEntries(result.headers),
        body: Buffer.from(result.body).toString("base64"),
      }
    }
    throw new Error("Unknown project capability.")
  }
}
