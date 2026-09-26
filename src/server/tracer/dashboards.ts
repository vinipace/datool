import { readCatalog, CATALOG_LIMIT } from "./catalog-read"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  dashboardInputSchema,
  dashboardUpdateSchema,
  type Dashboard,
} from "@/src/lib/tracer/dashboards"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { validateSemanticQuery } from "@/src/server/semantic/executor"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { dashboards } from "./schema"
import { dashboardCohorts } from "@/src/lib/tracer/dashboard-filters"

function decode(row: typeof dashboards.$inferSelect): Dashboard {
  return {
    ...config(JSON.parse(row.configJson)),
    id: row.id,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
function config(value: unknown) {
  const parsed = dashboardInputSchema.safeParse(value)
  if (!parsed.success)
    throw validation(parsed.error.issues[0]?.message ?? "Invalid dashboard.")
  try {
    for (const widget of parsed.data.widgets)
      for (const cohort of dashboardCohorts(widget))
        validateSemanticQuery(cohort.query, semanticCatalog)
  } catch (error) {
    throw validation(
      error instanceof Error ? error.message : "Invalid widget query."
    )
  }
  return parsed.data
}
export function createDashboardService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const get = async (id: string) => {
    const [row] = await database
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.projectId, projectId), eq(dashboards.id, id)))
    if (!row) throw notFound("Dashboard", id)
    return decode(row)
  }
  return {
    list: () =>
      tracerEffect(() =>
        readCatalog(
          database,
          sql`select * from ${dashboards} where ${dashboards.projectId}=${projectId}`,
          async (scoped) =>
            (
              await scoped
                .select()
                .from(dashboards)
                .where(eq(dashboards.projectId, projectId))
                .orderBy(desc(dashboards.updatedAt), desc(dashboards.id))
                .limit(CATALOG_LIMIT + 1)
            ).map(decode)
        )
      ),
    get: (id: string) => tracerEffect(() => get(id)),
    create: (value: unknown) =>
      tracerEffect(async () => {
        const input = config(value)
        const now = new Date().toISOString()
        const [row] = await database
          .insert(dashboards)
          .values({
            projectId,
            id: `dash_${crypto.randomUUID()}`,
            name: input.name,
            configJson: JSON.stringify(input),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        return decode(row)
      }),
    update: (id: string, value: unknown) =>
      tracerEffect(async () => {
        const parsed = dashboardUpdateSchema.safeParse(value)
        if (!parsed.success)
          throw validation(
            "A valid dashboard and expectedRevision are required."
          )
        const input = config(parsed.data.config)
        const [row] = await database
          .update(dashboards)
          .set({
            name: input.name,
            configJson: JSON.stringify(input),
            revision: parsed.data.expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              and(eq(dashboards.projectId, projectId), eq(dashboards.id, id)),
              and(
                eq(dashboards.projectId, projectId),
                eq(dashboards.revision, parsed.data.expectedRevision)
              )
            )
          )
          .returning()
        if (!row) {
          await get(id)
          throw new TracerError(
            "CONFLICT",
            "This dashboard changed. Reopen it before saving again."
          )
        }
        return decode(row)
      }),
    delete: (id: string, revision: number) =>
      tracerEffect(async () => {
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw validation("A valid expectedRevision is required.")
        const [row] = await database
          .delete(dashboards)
          .where(
            and(
              and(eq(dashboards.projectId, projectId), eq(dashboards.id, id)),
              and(
                eq(dashboards.projectId, projectId),
                eq(dashboards.revision, revision)
              )
            )
          )
          .returning()
        if (!row) {
          await get(id)
          throw new TracerError(
            "CONFLICT",
            "This dashboard changed. Reopen it before deleting."
          )
        }
        return { id }
      }),
  }
}
