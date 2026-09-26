import { z } from "zod"
import { libraryEvaluatorIds } from "@/src/lib/tracer/scorer-libraries"
import { readCatalog } from "./catalog-read"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  defaultScorer,
  libraryScorerPreset,
  scorerInputSchema,
  type Scorer,
} from "@/src/lib/tracer/scorers"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError } from "./errors"
import { scorers, evaluators, evaluatorVersions } from "./schema"

function decode(row: typeof scorers.$inferSelect): Scorer {
  const { configJson, ...fields } = row
  return { ...scorerInputSchema.parse(JSON.parse(configJson)), ...fields }
}
/** Both catalogs share evaluator IDs and immutable executable versions. */
export function createScorerService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  async function get(id: string): Promise<Scorer> {
    const [row] = await database
      .select()
      .from(scorers)
      .where(and(eq(scorers.projectId, projectId), eq(scorers.id, id)))
    if (row) return decode(row)
    const [legacy] = await database
      .select()
      .from(evaluators)
      .where(and(eq(evaluators.projectId, projectId), eq(evaluators.id, id)))
    if (!legacy) throw notFound("Scorer", id)
    const [version] = await database
      .select()
      .from(evaluatorVersions)
      .where(
        and(
          eq(evaluatorVersions.projectId, projectId),
          eq(evaluatorVersions.id, legacy.activeVersionId!)
        )
      )
    return {
      ...defaultScorer,
      type: version.language === "python" ? "python" : "javascript",
      code: version.code,
      name: legacy.name,
      description: legacy.description ?? "",
      slug: `legacy-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      id,
      revision: version.version,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    }
  }
  async function save(value: unknown, id?: string): Promise<Scorer> {
    const config = scorerInputSchema.parse(value)
    const expected = (value as { expectedRevision?: number }).expectedRevision
    const timestamp = new Date().toISOString()
    const scorerId = id ?? `scorer_${crypto.randomUUID()}`
    await database
      .transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(scorers)
          .where(
            and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId))
          )
          .for("update")
        const [legacy] = await tx
          .select()
          .from(evaluators)
          .where(
            and(
              eq(evaluators.projectId, projectId),
              eq(evaluators.id, scorerId)
            )
          )
          .for("update")
        if (id && !row && !legacy) throw notFound("Scorer", id)
        const [previousVersion] = legacy
          ? await tx
              .select()
              .from(evaluatorVersions)
              .where(
                and(
                  eq(evaluatorVersions.projectId, projectId),
                  eq(evaluatorVersions.id, legacy.activeVersionId!)
                )
              )
          : []
        const revision = row?.revision ?? previousVersion?.version ?? 0
        if (expected !== undefined && expected !== revision)
          throw new TracerError(
            "CONFLICT",
            "Scorer changed. Pull or reload before saving."
          )
        const serialized = JSON.stringify(config)
        if (
          row &&
          JSON.stringify(
            scorerInputSchema.parse(JSON.parse(row.configJson))
          ) === serialized &&
          previousVersion?.configJson
        )
          return
        const next = Math.max(revision, previousVersion?.version ?? 0) + 1
        const versionId = `evalv_${crypto.randomUUID()}`
        if (legacy)
          await tx
            .update(evaluators)
            .set({
              name: config.name,
              description: config.description,
              activeVersionId: versionId,
              updatedAt: timestamp,
            })
            .where(
              and(
                eq(evaluators.projectId, projectId),
                eq(evaluators.id, scorerId)
              )
            )
        else
          await tx.insert(evaluators).values({
            projectId,
            id: scorerId,
            name: config.name,
            description: config.description,
            activeVersionId: versionId,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        await tx.insert(evaluatorVersions).values({
          projectId,
          id: versionId,
          evaluatorId: scorerId,
          version: next,
          language: config.type === "python" ? "python" : "javascript",
          code: config.code,
          configJson: serialized,
          createdAt: timestamp,
        })
        if (row)
          await tx
            .update(scorers)
            .set({
              slug: config.slug,
              configJson: serialized,
              revision: next,
              updatedAt: timestamp,
            })
            .where(
              and(eq(scorers.projectId, projectId), eq(scorers.id, scorerId))
            )
        else
          await tx.insert(scorers).values({
            projectId,
            id: scorerId,
            slug: config.slug,
            configJson: serialized,
            revision: next,
            createdAt: legacy?.createdAt ?? timestamp,
            updatedAt: timestamp,
          })
      })
      .catch((error) => {
        if (
          `${error} ${(error as Error).cause}`.includes("unique") ||
          `${error} ${(error as Error).cause}`.includes("UNIQUE")
        )
          throw new TracerError(
            "CONFLICT",
            "A scorer with this slug already exists, or its name is already used."
          )
        throw error
      })
    return get(scorerId)
  }
  async function selectLibrary(value: unknown): Promise<Scorer> {
    const { evaluator } = z
      .object({ evaluator: z.enum(libraryEvaluatorIds) })
      .strict()
      .parse(value)
    const preset = libraryScorerPreset(evaluator)
    const existing = async () => {
      const [row] = await database
        .select()
        .from(scorers)
        .where(
          and(eq(scorers.projectId, projectId), eq(scorers.slug, preset.slug))
        )
      if (!row) return null
      const scorer = decode(row)
      if (
        scorer.type !== "library" ||
        scorer.library?.evaluator !== evaluator ||
        scorer.library.version !== preset.library!.version ||
        scorer.library.adapterVersion !== preset.library!.adapterVersion
      )
        throw new TracerError(
          "CONFLICT",
          "The library scorer's saved configuration has changed. Select it from This project or rename its slug first."
        )
      return scorer
    }
    const found = await existing()
    if (found) return found
    try {
      return await save(preset)
    } catch (error) {
      // Concurrent selections share the project-unique slug, without new versions.
      if (error instanceof TracerError && error.code === "CONFLICT") {
        const created = await existing()
        if (created) return created
      }
      throw error
    }
  }
  return {
    useLibrary: (value: unknown) => tracerEffect(() => selectLibrary(value)),
    get: (id: string) => tracerEffect(() => get(id)),
    list: () =>
      tracerEffect(() =>
        readCatalog(
          database,
          sql`select config_json as payload from scorers where project_id=${projectId} union all select v.code from evaluator_versions v join evaluators e on e.project_id=v.project_id and e.active_version_id=v.id where e.project_id=${projectId}`,
          async (scoped) => {
            const rows = await scoped
              .select()
              .from(scorers)
              .where(eq(scorers.projectId, projectId))
              .orderBy(desc(scorers.updatedAt))
              .limit(501)
            const existingIds = new Set(rows.map((row) => row.id))
            const legacy = await scoped
              .select({ evaluator: evaluators, version: evaluatorVersions })
              .from(evaluators)
              .innerJoin(
                evaluatorVersions,
                and(
                  eq(evaluatorVersions.projectId, projectId),
                  eq(evaluatorVersions.id, evaluators.activeVersionId)
                )
              )
              .where(eq(evaluators.projectId, projectId))
              .limit(501)
            if (rows.length > 500 || legacy.length > 500)
              throw new TracerError(
                "READ_RESULT_TOO_LARGE",
                "Scorer catalog exceeds 500 entries. Use a specific scorer ID."
              )
            return [
              ...rows.map(decode),
              ...legacy
                .filter(({ evaluator }) => !existingIds.has(evaluator.id))
                .map(({ evaluator, version }): Scorer => ({
                  ...defaultScorer,
                  type: version.language === "python" ? "python" : "javascript",
                  code: version.code,
                  name: evaluator.name,
                  description: evaluator.description ?? "",
                  slug: `legacy-${evaluator.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                  id: evaluator.id,
                  revision: version.version,
                  createdAt: evaluator.createdAt,
                  updatedAt: evaluator.updatedAt,
                })),
            ]
          }
        )
      ),
    save: (value: unknown, id?: string) => tracerEffect(() => save(value, id)),
    remove: (id: string) =>
      tracerEffect(async () => {
        await get(id)
        try {
          await database.transaction(async (tx) => {
            await tx
              .delete(evaluators)
              .where(
                and(eq(evaluators.projectId, projectId), eq(evaluators.id, id))
              )
            await tx
              .delete(scorers)
              .where(and(eq(scorers.projectId, projectId), eq(scorers.id, id)))
          })
        } catch {
          throw new TracerError(
            "CONFLICT",
            "This scorer is referenced by evaluation or review history and cannot be deleted."
          )
        }
        return { id }
      }),
  }
}
