import { readCatalog, CATALOG_LIMIT } from "./catalog-read"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  customViewInputSchema,
  customViewSchema,
  customViewUpdateSchema,
  type CustomView,
} from "@/src/lib/tracer/custom-views"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { customViews } from "./schema"

function decode(row: typeof customViews.$inferSelect): CustomView {
  const { settingsJson, projectId, ...fields } = row
  void projectId // Tenant scope is not part of the public configuration schema.
  return customViewSchema.parse({
    ...fields,
    settings: JSON.parse(settingsJson),
  })
}
function parse<T>(
  schema: {
    safeParse: (
      value: unknown
    ) =>
      | { success: true; data: T }
      | { success: false; error: { message: string } }
  },
  value: unknown
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw validation(result.error.message)
  return result.data
}

export function createCustomViewService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const get = async (id: string) => {
    const [row] = await database
      .select()
      .from(customViews)
      .where(and(eq(customViews.projectId, projectId), eq(customViews.id, id)))
    if (!row) throw notFound("Custom view", id)
    return decode(row)
  }
  return {
    list: (resource: string) =>
      tracerEffect(async () => {
        if (!customViewInputSchema.shape.resource.safeParse(resource).success)
          throw validation("Unsupported custom view resource.")
        return readCatalog(
          database,
          sql`select * from ${customViews} where ${customViews.projectId}=${projectId} and ${customViews.resource}=${resource}`,
          async (scoped) =>
            (
              await scoped
                .select()
                .from(customViews)
                .where(
                  and(
                    eq(customViews.projectId, projectId),
                    eq(customViews.resource, resource)
                  )
                )
                .orderBy(desc(customViews.updatedAt), desc(customViews.id))
                .limit(CATALOG_LIMIT + 1)
            ).map(decode)
        )
      }),
    get: (id: string) => tracerEffect(() => get(id)),
    create: (value: unknown) =>
      tracerEffect(async () => {
        const input = parse(customViewInputSchema, value)
        const now = new Date().toISOString()
        const [row] = await database
          .insert(customViews)
          .values({
            projectId,
            id: `cview_${crypto.randomUUID()}`,
            name: input.name,
            resource: input.resource,
            settingsJson: JSON.stringify(input.settings),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return decode(row)
      }),
    update: (id: string, value: unknown) =>
      tracerEffect(async () => {
        const input = parse(customViewUpdateSchema, value)
        const [row] = await database
          .update(customViews)
          .set({
            name: input.name,
            settingsJson: JSON.stringify(input.settings),
            revision: input.expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              and(eq(customViews.projectId, projectId), eq(customViews.id, id)),
              and(
                eq(customViews.projectId, projectId),
                eq(customViews.resource, input.resource)
              ),
              and(
                eq(customViews.projectId, projectId),
                eq(customViews.revision, input.expectedRevision)
              )
            )
          )
          .returning()
        if (!row) {
          await get(id)
          throw new TracerError(
            "CONFLICT",
            "This view changed in another browser. Reload the saved view before saving again, or save your changes as a new view."
          )
        }
        return decode(row)
      }),
    delete: (id: string, expectedRevision: number) =>
      tracerEffect(async () => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
          throw validation("A valid expectedRevision is required.")
        const [row] = await database
          .delete(customViews)
          .where(
            and(
              and(eq(customViews.projectId, projectId), eq(customViews.id, id)),
              and(
                eq(customViews.projectId, projectId),
                eq(customViews.revision, expectedRevision)
              )
            )
          )
          .returning()
        if (!row) {
          await get(id)
          throw new TracerError(
            "CONFLICT",
            "This view changed in another browser. Reload it before deleting."
          )
        }
        return { id }
      }),
  }
}
