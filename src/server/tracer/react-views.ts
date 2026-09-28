import { and, asc, eq, gt, sql } from "drizzle-orm"
import { z } from "zod"
import {
  createReactViewSchema,
  updateReactViewSchema,
  reactViewSchema,
  type ReactViewOrigin,
  type ReactViewSource,
} from "@/src/lib/tracer/react-views"
import { workspaceIdentity } from "@/src/server/auth/context"
import { requireScopes } from "@/src/server/auth/request"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { datasetItems, datasets, reactViews, traces } from "./schema"

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw validation(
      result.error.issues.map((issue) => issue.message).join("; ")
    )
  return result.data
}
export function createReactViewService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const scoped = (id: string) =>
    and(eq(reactViews.projectId, projectId), eq(reactViews.id, id))
  const get = async (id: string) => {
    const [row] = await database.select().from(reactViews).where(scoped(id))
    if (!row) throw notFound("React view", id)
    return reactViewSchema.parse(row)
  }
  async function origin(
    source: ReactViewSource | null
  ): Promise<ReactViewOrigin | null> {
    if (!source) return null
    const identity = workspaceIdentity()
    if (!identity || identity.projectId !== projectId)
      throw new TracerError("UNAUTHORIZED", "Project identity is required.")
    requireScopes(identity.scopes, [
      source.kind === "trace" ? "traces:read" : "datasets:read",
    ])
    let datasetId: string | null = null
    let datasetName: string | null = null
    let traceId: string | null = source.kind === "trace" ? source.id : null
    let name = ""
    if (source.kind === "dataset-item") {
      const [row] = await database
        .select({ item: datasetItems, dataset: datasets })
        .from(datasetItems)
        .innerJoin(
          datasets,
          and(
            eq(datasets.projectId, projectId),
            eq(datasets.id, datasetItems.datasetId)
          )
        )
        .where(
          and(
            eq(datasetItems.projectId, projectId),
            eq(datasetItems.id, source.id)
          )
        )
      if (!row) throw notFound("Dataset item", source.id)
      datasetId = row.dataset.id
      datasetName = row.dataset.name
      name = `Dataset row ${source.id.slice(-8)}`
      // Include linked trace context only when the creator may read that trace.
      traceId = identity.scopes.includes("traces:read")
        ? row.item.sourceTraceId
        : null
    }
    const [trace] = traceId
      ? await database
          .select({
            name: traces.name,
            operation: traces.operation,
            groupType: traces.groupType,
            groupName: traces.groupName,
            groupVersion: traces.groupVersion,
          })
          .from(traces)
          .where(and(eq(traces.projectId, projectId), eq(traces.id, traceId)))
      : []
    if (source.kind === "trace" && !trace) throw notFound("Trace", source.id)
    return {
      source,
      name: name || trace!.name,
      datasetId,
      datasetName,
      traceId,
      traceName: trace?.name ?? null,
      operation: trace?.operation ?? null,
      group:
        trace?.groupName &&
        (trace.groupType === "agent" || trace.groupType === "workflow")
          ? {
              type: trace.groupType,
              name: trace.groupName,
              version: trace.groupVersion,
            }
          : null,
    }
  }
  const conflict = () =>
    new TracerError(
      "CONFLICT",
      "This view changed in another browser. Reload it or save your edits as a new view."
    )
  return {
    list: (options: { cursor?: string; limit?: number } = {}) =>
      tracerEffect(async () => {
        const { cursor, limit } = parse(
          z.object({
            cursor: z.string().min(1).max(200).optional(),
            limit: z.number().int().min(1).max(100).default(50),
          }),
          options
        )
        const rows = await database
          .select({
            id: reactViews.id,
            projectId: reactViews.projectId,
            name: reactViews.name,
            description: reactViews.description,
            dataMode: reactViews.dataMode,
            requirements: reactViews.requirements,
            origin: reactViews.origin,
            author: reactViews.author,
            revision: reactViews.revision,
            createdAt: reactViews.createdAt,
            updatedAt: reactViews.updatedAt,
            objectTypes: reactViews.objectTypes,
            inputContract: reactViews.inputContract,
            customFields: reactViews.customFields,
          })
          .from(reactViews)
          .where(
            and(
              eq(reactViews.projectId, projectId),
              cursor ? gt(reactViews.id, cursor) : undefined
            )
          )
          .orderBy(asc(reactViews.id))
          .limit(limit + 1)
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1].id : null,
        }
      }),
    get: (id: string) => tracerEffect(() => get(id)),
    create: (value: unknown) =>
      tracerEffect(async () => {
        const { source, ...input } = parse(createReactViewSchema, value)
        const identity = workspaceIdentity()
        if (!identity || identity.projectId !== projectId)
          throw new TracerError("UNAUTHORIZED", "Project identity is required.")
        const user = identity.userId
          ? await database.execute<{ name: string }>(
              sql`select name from "user" where id=${identity.userId}`
            )
          : null
        const author = {
          id: identity.userId ?? identity.apiKeyId ?? "api-key",
          name: user?.rows[0]?.name ?? identity.apiKeyName ?? "API key",
          kind: identity.kind,
        }
        const now = new Date().toISOString()
        const [row] = await database
          .insert(reactViews)
          .values({
            ...input,
            id: `rview_${crypto.randomUUID()}`,
            projectId,
            origin: await origin(source),
            author,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return reactViewSchema.parse(row)
      }),
    update: (id: string, value: unknown) =>
      tracerEffect(async () => {
        const { expectedRevision, ...input } = parse(
          updateReactViewSchema,
          value
        )
        const [row] = await database
          .update(reactViews)
          .set({
            ...input,
            revision: expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(and(scoped(id), eq(reactViews.revision, expectedRevision)))
          .returning()
        if (!row) {
          await get(id)
          throw conflict()
        }
        return reactViewSchema.parse(row)
      }),
    delete: (id: string, expectedRevision: number) =>
      tracerEffect(async () => {
        parse(z.number().int().positive(), expectedRevision)
        const [row] = await database
          .delete(reactViews)
          .where(and(scoped(id), eq(reactViews.revision, expectedRevision)))
          .returning({ id: reactViews.id })
        if (!row) {
          await get(id)
          throw conflict()
        }
        return row
      }),
  }
}
