import {
  promptOverridesSchema,
  type PromptOverrides,
  type FrozenPromptConfig,
} from "@/src/lib/tracer/prompt-overrides"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  promptDraftSchema,
  promptInputSchema,
  promptUpdateSchema,
  promptPublishSchema,
  type ManagedPrompt,
} from "@/src/lib/tracer/prompts"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { managedPrompts, managedPromptVersions } from "./schema"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { readCatalog } from "./catalog-read"
import type { PromptCache } from "./prompt-cache"

type PromptRow = typeof managedPrompts.$inferSelect
function decode(
  row: PromptRow,
  snapshot?: { configJson: string; revision: number; createdAt: string }
): ManagedPrompt {
  return {
    ...promptDraftSchema.parse(
      JSON.parse(snapshot?.configJson ?? row.configJson)
    ),
    id: row.id,
    revision: row.revision,
    version: snapshot?.revision ?? null,
    publishedVersion: row.publishedVersion,
    publishedAt: row.publishedAt,
    hasDraft: row.configJson !== row.publishedConfigJson,
    createdAt: row.createdAt,
    updatedAt: snapshot?.createdAt ?? row.updatedAt,
  }
}
function assertRevision(row: PromptRow, expectedRevision: number | undefined) {
  if (row.revision !== expectedRevision)
    throw new TracerError(
      "CONFLICT",
      "This prompt changed. Reload before saving or publishing to keep the latest draft."
    )
}
export function createPromptService(
  database: TracerDatabase,
  cache?: PromptCache
) {
  const projectId = getTracerProjectId(database)
  const scope = (id: string) =>
    and(eq(managedPrompts.projectId, projectId), eq(managedPrompts.id, id))
  async function get(
    id: string,
    bySlug = false,
    version?: number
  ): Promise<ManagedPrompt> {
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1)
    )
      throw validation("Version must be a positive integer.")
    const [row] = await database
      .select()
      .from(managedPrompts)
      .where(
        and(
          eq(managedPrompts.projectId, projectId),
          bySlug ? eq(managedPrompts.slug, id) : eq(managedPrompts.id, id)
        )
      )
    if (!row) throw notFound("Prompt", id)
    // Runtime slug lookups never expose the working draft.
    if (version === undefined) {
      if (!bySlug) return decode(row)
      if (
        row.publishedVersion === null ||
        row.publishedConfigJson === null ||
        row.publishedAt === null
      )
        throw notFound("Published prompt", id)
      return decode(row, {
        configJson: row.publishedConfigJson,
        revision: row.publishedVersion,
        createdAt: row.publishedAt,
      })
    }
    const [snapshot] = await database
      .select()
      .from(managedPromptVersions)
      .where(
        and(
          eq(managedPromptVersions.projectId, projectId),
          eq(managedPromptVersions.promptId, row.id),
          eq(managedPromptVersions.revision, version)
        )
      )
    if (!snapshot) throw notFound("Prompt version", String(version))
    return decode(row, snapshot)
  }
  async function save(value: unknown, id?: string) {
    const result = (id ? promptUpdateSchema : promptDraftSchema).safeParse(
      value
    )
    if (!result.success)
      throw validation(
        result.error.issues.map((issue) => issue.message).join(" ")
      )
    const parsed = result.data
    const expectedRevision =
      "expectedRevision" in parsed &&
      typeof parsed.expectedRevision === "number"
        ? parsed.expectedRevision
        : undefined
    const config = promptDraftSchema.parse(parsed)
    const promptId = id ?? `prompt_${crypto.randomUUID()}`
    const timestamp = new Date().toISOString()
    try {
      const saved = await database.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(managedPrompts)
          .where(scope(promptId))
          .for("update")
        if (id && !previous) throw notFound("Prompt", id)
        if (previous) {
          assertRevision(previous, expectedRevision)
          if (
            previous.publishedVersion !== null &&
            previous.slug !== config.slug
          )
            throw validation(
              "A published prompt's slug cannot be changed. Create a new prompt to use another slug."
            )
        }
        const configJson = JSON.stringify(config)
        if (previous?.configJson === configJson) return decode(previous)
        const next: PromptRow = {
          id: promptId,
          projectId,
          slug: config.slug,
          configJson,
          revision: (previous?.revision ?? 0) + 1,
          publishedVersion: previous?.publishedVersion ?? null,
          publishedConfigJson: previous?.publishedConfigJson ?? null,
          publishedAt: previous?.publishedAt ?? null,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        }
        if (previous)
          await tx.update(managedPrompts).set(next).where(scope(promptId))
        else await tx.insert(managedPrompts).values(next)
        return decode(next)
      })
      await cache?.invalidate(projectId)
      return saved
    } catch (error) {
      const cause = error as { code?: string; cause?: { code?: string } }
      if (cause.code === "23505" || cause.cause?.code === "23505")
        throw new TracerError(
          "CONFLICT",
          "A prompt with this slug already exists in this project."
        )
      throw error
    }
  }
  async function publish(id: string, value: unknown) {
    const parsed = promptPublishSchema.safeParse(value)
    if (!parsed.success) throw validation("expectedRevision is required.")
    const published = await database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(managedPrompts)
        .where(scope(id))
        .for("update")
      if (!row) throw notFound("Prompt", id)
      assertRevision(row, parsed.data.expectedRevision)
      const config = promptInputSchema.safeParse(JSON.parse(row.configJson))
      if (!config.success)
        throw validation(
          config.error.issues.map((issue) => issue.message).join(" ")
        )
      if (row.configJson === row.publishedConfigJson) return decode(row)
      const timestamp = new Date().toISOString()
      const version = (row.publishedVersion ?? 0) + 1
      await tx.insert(managedPromptVersions).values({
        id: `promptv_${crypto.randomUUID()}`,
        projectId,
        promptId: id,
        revision: version,
        configJson: row.configJson,
        createdAt: timestamp,
      })
      const next: PromptRow = {
        ...row,
        revision: row.revision + 1,
        publishedVersion: version,
        publishedConfigJson: row.configJson,
        publishedAt: timestamp,
        updatedAt: timestamp,
      }
      await tx.update(managedPrompts).set(next).where(scope(id))
      return decode(next)
    })
    await cache?.invalidate(projectId)
    return published
  }
  async function freeze(
    overrides: PromptOverrides = {}
  ): Promise<FrozenPromptConfig> {
    const parsed = promptOverridesSchema.parse(overrides)
    // One MVCC statement observes every latest version and selected historical version
    // together. No per-case latest lookups, draft reads or publication-time race.
    const rows = await database.execute(sql`
      select p.id, p.slug, p.published_version as "latestVersion", v.revision as version, v.config_json::jsonb ->> 'model' as model
      from managed_prompts p join managed_prompt_versions v
        on v.project_id=p.project_id and v.prompt_id=p.id
        and v.revision=coalesce((${JSON.stringify(parsed)}::jsonb -> p.slug ->> 'version')::int,p.published_version)
      where p.project_id=${projectId} and p.published_version is not null
      limit 10001
    `)
    if (rows.rows.length > 10000)
      throw validation("Published prompt catalog exceeds 10,000 prompts.")
    const prompts: FrozenPromptConfig["prompts"] = Object.create(null)
    for (const row of rows.rows) {
      prompts[String(row.slug)] = {
        id: String(row.id),
        version: Number(row.version),
        latestVersion: Number(row.latestVersion),
        model: parsed[String(row.slug)]?.model ?? String(row.model),
      }
    }
    for (const slug of Object.keys(parsed))
      if (!prompts[slug])
        throw validation(`Published prompt or version not found: ${slug}.`)
    const result = { projectId, prompts, overrides: parsed }
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
      throw validation(
        "Published prompt catalog exceeds the 512 KiB run snapshot limit."
      )
    return result
  }
  return {
    freeze: (overrides?: PromptOverrides) =>
      tracerEffect(() => freeze(overrides)),
    get: (id: string, bySlug = false, version?: number) =>
      tracerEffect(() => {
        if (
          version !== undefined &&
          (!Number.isSafeInteger(version) || version < 1)
        )
          throw validation("Version must be a positive integer.")
        const load = () => get(id, bySlug, version)
        // Working drafts are always read directly. Published runtime responses
        // include model, metadata and publication state as one cached snapshot.
        return cache && (bySlug || version !== undefined)
          ? cache.get(projectId, { id, bySlug, version }, load)
          : load()
      }),
    list: () =>
      tracerEffect(() =>
        readCatalog(
          database,
          sql`select config_json || coalesce(published_config_json, '') as payload from managed_prompts where project_id=${projectId}`,
          async (tx) =>
            (
              await tx
                .select()
                .from(managedPrompts)
                .where(eq(managedPrompts.projectId, projectId))
                .orderBy(desc(managedPrompts.updatedAt))
                .limit(501)
            ).map((row) => decode(row))
        )
      ),
    save: (value: unknown, id?: string) => tracerEffect(() => save(value, id)),
    publish: (id: string, value: unknown) =>
      tracerEffect(() => publish(id, value)),
    remove: (id: string, expectedRevision: number) =>
      tracerEffect(async () => {
        const [removed] = await database
          .delete(managedPrompts)
          .where(and(scope(id), eq(managedPrompts.revision, expectedRevision)))
          .returning({ id: managedPrompts.id })
        if (!removed) {
          await get(id)
          throw new TracerError(
            "CONFLICT",
            "This prompt changed. Reload before deleting."
          )
        }
        await cache?.invalidate(projectId)
        return removed
      }),
  }
}
