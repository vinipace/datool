import { randomUUID } from "node:crypto"

import { and, asc, desc, eq, isNull } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { z } from "zod"

import {
  actionDefinitionSchema,
  agentConfigurationSchema,
  procedureDefinitionSchema,
  type AgentConfiguration,
  type AgentRevision,
  type AgentStatus,
  type ManagedAgent,
  type ProcedureStep,
  widgetDefinitionSchema,
  type SaveAgentInput,
} from "@/src/lib/build/contracts"
import type { BuildContext } from "./context"
import {
  REDACTED_ACTION_HEADER,
  decryptActionHeaders,
  encryptActionHeaders,
  publicActionDefinition,
} from "./definitions"
import {
  buildActionRevisions,
  buildActions,
  buildAgentRevisions,
  buildAgentCatalogActions,
  buildAgentCatalogProcedures,
  buildAgentCatalogSnapshots,
  buildAgentCatalogWidgets,
  buildAgents,
  buildProcedureRevisions,
  buildProcedures,
  buildWidgetRevisions,
  buildWidgets,
  type BuildCatalogSchema,
} from "./catalog-schema"

type BuildDatabase = NodePgDatabase<BuildCatalogSchema>
type BuildTransaction = Parameters<
  Parameters<BuildDatabase["transaction"]>[0]
>[0]

function database(context: BuildContext): BuildDatabase {
  return context.database as unknown as BuildDatabase
}

/**
 * Persist the exact definition revisions that an applied agent revision is
 * allowed to execute. This is deliberately written in the same transaction
 * as the agent revision so a runtime worker can never observe a half-applied
 * catalog. When restoring an applied revision, copy its prior immutable
 * snapshot; draft revisions have no snapshot and therefore use the current
 * definition rows when they are applied.
 */
async function createCatalogSnapshot(
  tx: BuildTransaction,
  context: BuildContext,
  agentId: string,
  agentRevision: number,
  sourceRevision?: number
) {
  const catalogId = randomUUID()
  const now = new Date().toISOString()
  await tx.insert(buildAgentCatalogSnapshots).values({
    id: catalogId,
    projectId: context.projectId,
    agentId,
    agentRevision,
    createdAt: now,
    createdBy: context.actorId ?? null,
  })

  let actionRefs: Array<{ actionId: string; revision: number }> = []
  let procedureRefs: Array<{ procedureId: string; revision: number }> = []
  let widgetRefs: Array<{ widgetId: string; revision: number }> = []
  let hasSourceSnapshot = false
  if (sourceRevision !== undefined) {
    const sourceRows = await tx
      .select({ id: buildAgentCatalogSnapshots.id })
      .from(buildAgentCatalogSnapshots)
      .where(
        and(
          eq(buildAgentCatalogSnapshots.projectId, context.projectId),
          eq(buildAgentCatalogSnapshots.agentId, agentId),
          eq(buildAgentCatalogSnapshots.agentRevision, sourceRevision)
        )
      )
      .limit(1)
    const source = sourceRows[0]
    if (source) {
      hasSourceSnapshot = true
      actionRefs = await tx
        .select({
          actionId: buildAgentCatalogActions.actionId,
          revision: buildAgentCatalogActions.revision,
        })
        .from(buildAgentCatalogActions)
        .where(
          and(
            eq(buildAgentCatalogActions.projectId, context.projectId),
            eq(buildAgentCatalogActions.catalogId, source.id)
          )
        )
      procedureRefs = await tx
        .select({
          procedureId: buildAgentCatalogProcedures.procedureId,
          revision: buildAgentCatalogProcedures.revision,
        })
        .from(buildAgentCatalogProcedures)
        .where(
          and(
            eq(buildAgentCatalogProcedures.projectId, context.projectId),
            eq(buildAgentCatalogProcedures.catalogId, source.id)
          )
        )
      widgetRefs = await tx
        .select({
          widgetId: buildAgentCatalogWidgets.widgetId,
          revision: buildAgentCatalogWidgets.revision,
        })
        .from(buildAgentCatalogWidgets)
        .where(
          and(
            eq(buildAgentCatalogWidgets.projectId, context.projectId),
            eq(buildAgentCatalogWidgets.catalogId, source.id)
          )
        )
    }
  }

  // A draft source has no snapshot. In that case an apply publishes the
  // current active definition rows as their exact immutable revisions.
  if (sourceRevision === undefined || !hasSourceSnapshot) {
    const [actions, procedures, widgets] = await Promise.all([
      tx
        .select({ actionId: buildActions.id, revision: buildActions.revision })
        .from(buildActions)
        .where(
          and(
            eq(buildActions.projectId, context.projectId),
            eq(buildActions.agentId, agentId),
            isNull(buildActions.deletedAt)
          )
        ),
      tx
        .select({
          procedureId: buildProcedures.id,
          revision: buildProcedures.revision,
        })
        .from(buildProcedures)
        .where(
          and(
            eq(buildProcedures.projectId, context.projectId),
            eq(buildProcedures.agentId, agentId),
            isNull(buildProcedures.deletedAt)
          )
        ),
      tx
        .select({ widgetId: buildWidgets.id, revision: buildWidgets.revision })
        .from(buildWidgets)
        .where(
          and(
            eq(buildWidgets.projectId, context.projectId),
            eq(buildWidgets.agentId, agentId),
            isNull(buildWidgets.deletedAt)
          )
        ),
    ])
    actionRefs = actions
    procedureRefs = procedures
    widgetRefs = widgets
  }

  if (actionRefs.length) {
    await tx.insert(buildAgentCatalogActions).values(
      actionRefs.map((ref) => ({
        projectId: context.projectId,
        catalogId,
        actionId: ref.actionId,
        revision: ref.revision,
      }))
    )
  }
  if (procedureRefs.length) {
    await tx.insert(buildAgentCatalogProcedures).values(
      procedureRefs.map((ref) => ({
        projectId: context.projectId,
        catalogId,
        procedureId: ref.procedureId,
        revision: ref.revision,
      }))
    )
  }
  if (widgetRefs.length) {
    await tx.insert(buildAgentCatalogWidgets).values(
      widgetRefs.map((ref) => ({
        projectId: context.projectId,
        catalogId,
        widgetId: ref.widgetId,
        revision: ref.revision,
      }))
    )
  }
  return catalogId
}

function remapActionId(
  value: string | null,
  actionIds: Map<string, string>,
  sourceId: string
): string | null {
  if (value === null) return null
  const mapped = actionIds.get(value)
  if (!mapped)
    throw new AgentConflictError(
      `Cannot clone agent: action ${value} referenced by ${sourceId} is unavailable.`
    )
  return mapped
}

function remapProcedureStep(
  step: ProcedureStep,
  actionIds: Map<string, string>,
  sourceId: string
): ProcedureStep {
  if (step.kind !== "action" && step.kind !== "handoff") return step
  return {
    ...step,
    actionId: remapActionId(step.actionId, actionIds, sourceId)!,
  }
}

async function cloneDefinitions(
  tx: BuildTransaction,
  context: BuildContext,
  sourceAgentId: string,
  targetAgentId: string,
  now: string
) {
  const [sourceActions, sourceProcedures, sourceWidgets] = await Promise.all([
    tx
      .select()
      .from(buildActions)
      .where(
        and(
          eq(buildActions.projectId, context.projectId),
          eq(buildActions.agentId, sourceAgentId),
          isNull(buildActions.deletedAt)
        )
      ),
    tx
      .select()
      .from(buildProcedures)
      .where(
        and(
          eq(buildProcedures.projectId, context.projectId),
          eq(buildProcedures.agentId, sourceAgentId),
          isNull(buildProcedures.deletedAt)
        )
      ),
    tx
      .select()
      .from(buildWidgets)
      .where(
        and(
          eq(buildWidgets.projectId, context.projectId),
          eq(buildWidgets.agentId, sourceAgentId),
          isNull(buildWidgets.deletedAt)
        )
      ),
  ])
  const actionIds = new Map(sourceActions.map((row) => [row.id, randomUUID()]))
  const widgetIds = new Map(sourceWidgets.map((row) => [row.id, randomUUID()]))

  for (const source of sourceWidgets) {
    const id = widgetIds.get(source.id)!
    const definition = widgetDefinitionSchema.parse(source.definitionJson)
    const cloned = {
      ...definition,
      components: definition.components.map((component) => {
        if (component.type === "button")
          return {
            ...component,
            actionId: remapActionId(component.actionId, actionIds, source.id)!,
          }
        if (component.type === "form")
          return {
            ...component,
            submitActionId: remapActionId(
              component.submitActionId,
              actionIds,
              source.id
            )!,
          }
        if (component.type === "card" && component.actionId)
          return {
            ...component,
            actionId: remapActionId(component.actionId, actionIds, source.id),
          }
        return component
      }),
      functions: definition.functions.map((fn) => ({
        ...fn,
        actionId: remapActionId(fn.actionId, actionIds, source.id),
      })),
    }
    const row = {
      id,
      projectId: context.projectId,
      agentId: targetAgentId,
      slug: source.slug,
      revision: 1,
      definitionJson: cloned,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await tx.insert(buildWidgets).values(row)
    await tx.insert(buildWidgetRevisions).values({
      id: randomUUID(),
      projectId: context.projectId,
      widgetId: id,
      agentId: targetAgentId,
      slug: row.slug,
      revision: 1,
      definitionJson: cloned,
      createdAt: now,
      createdBy: context.actorId ?? null,
    })
  }

  for (const source of sourceActions) {
    const id = actionIds.get(source.id)!
    const definition = actionDefinitionSchema.parse(source.definitionJson)
    const sourceHeaders =
      definition.type === "http"
        ? {
            ...definition.headers,
            ...(source.encryptedHeaders
              ? decryptActionHeaders(
                  source.encryptedHeaders,
                  context.projectId,
                  source.id
                )
              : {}),
          }
        : null
    const cloneDefinition =
      definition.type === "http"
        ? publicActionDefinition({
            ...definition,
            headers: sourceHeaders ?? {},
          })
        : definition
    const cloned = {
      ...cloneDefinition,
      id,
      ...(cloneDefinition.type === "widget"
        ? {
            widgetId:
              widgetIds.get(cloneDefinition.widgetId) ??
              (() => {
                throw new AgentConflictError(
                  `Cannot clone agent: widget ${cloneDefinition.widgetId} referenced by ${source.id} is unavailable.`
                )
              })(),
          }
        : {}),
      ...(cloneDefinition.type === "form"
        ? {
            submitActionId: remapActionId(
              cloneDefinition.submitActionId,
              actionIds,
              source.id
            ),
          }
        : {}),
    }
    const encryptedHeaders =
      cloneDefinition.type === "http"
        ? encryptActionHeaders(
            Object.fromEntries(
              Object.entries(sourceHeaders ?? {}).filter(
                ([, value]) => value !== REDACTED_ACTION_HEADER
              )
            ),
            context.projectId,
            id
          )
        : null
    const row = {
      id,
      projectId: context.projectId,
      agentId: targetAgentId,
      slug: source.slug,
      revision: 1,
      definitionJson: cloned,
      encryptedHeaders,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await tx.insert(buildActions).values(row)
    await tx.insert(buildActionRevisions).values({
      id: randomUUID(),
      projectId: context.projectId,
      actionId: id,
      agentId: targetAgentId,
      slug: row.slug,
      revision: 1,
      definitionJson: cloned,
      encryptedHeaders,
      createdAt: now,
      createdBy: context.actorId ?? null,
    })
  }

  for (const source of sourceProcedures) {
    const id = randomUUID()
    const definition = procedureDefinitionSchema.parse(source.definitionJson)
    const cloned = {
      ...definition,
      actionRefs: definition.actionRefs.map((actionId) =>
        remapActionId(actionId, actionIds, source.id)!
      ),
      steps: definition.steps.map((step) =>
        remapProcedureStep(step, actionIds, source.id)
      ),
      branches: definition.branches.map((branch) => ({
        ...branch,
        steps: branch.steps.map((step) =>
          remapProcedureStep(step, actionIds, source.id)
        ),
      })),
    }
    const row = {
      id,
      projectId: context.projectId,
      agentId: targetAgentId,
      slug: source.slug,
      revision: 1,
      definitionJson: cloned,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await tx.insert(buildProcedures).values(row)
    await tx.insert(buildProcedureRevisions).values({
      id: randomUUID(),
      projectId: context.projectId,
      procedureId: id,
      agentId: targetAgentId,
      slug: row.slug,
      revision: 1,
      definitionJson: cloned,
      createdAt: now,
      createdBy: context.actorId ?? null,
    })
  }
}

export class AgentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
}

export class AgentConflictError extends Error {
  readonly code = "CONFLICT"
}

export class AgentValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
}

function parseConfiguration(value: unknown): AgentConfiguration {
  try {
    return agentConfigurationSchema.parse(value)
  } catch (error) {
    throw new AgentValidationError(
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error)
    )
  }
}

function normalizeSlug(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!candidate || candidate.length > 120) {
    throw new AgentValidationError(
      "Agent slug must contain 1 to 120 URL-safe characters."
    )
  }
  return candidate
}

function requireName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 160)
    throw new AgentValidationError(
      "Agent name must contain 1 to 160 characters."
    )
  return name
}

function agentModel(row: typeof buildAgents.$inferSelect): ManagedAgent {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status as AgentStatus,
    currentRevision: row.currentRevision,
    appliedRevision: row.appliedRevision,
    configuration: parseConfiguration(row.currentConfigJson),
    appliedConfiguration: parseConfiguration(row.appliedConfigJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

function revisionModel(
  row: typeof buildAgentRevisions.$inferSelect
): AgentRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    revision: row.revision,
    configuration: parseConfiguration(row.configJson),
    state: row.state as AgentRevision["state"],
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export type CreateAgentInput = {
  id?: string
  slug?: string
  name: string
  description?: string | null
  configuration?: unknown
  /** Internal clone path; public callers should use cloneAgent. */
  cloneFromAgentId?: string
}

type InternalSaveAgentInput = SaveAgentInput & {
  /** Existing applied catalog to restore; never accepted from public callers. */
  catalogRevision?: number
}

export type ListAgentsOptions = { includeArchived?: boolean }

export async function listAgents(
  context: BuildContext,
  options: ListAgentsOptions = {}
): Promise<ManagedAgent[]> {
  const predicates = [eq(buildAgents.projectId, context.projectId)]
  if (!options.includeArchived)
    predicates.push(eq(buildAgents.status, "active"))
  const rows = await database(context)
    .select()
    .from(buildAgents)
    .where(and(...predicates))
    .orderBy(asc(buildAgents.name))
  return rows.map(agentModel)
}

export async function getAgent(
  context: BuildContext,
  agentId: string,
  options: ListAgentsOptions = {}
): Promise<ManagedAgent> {
  const predicates = [
    eq(buildAgents.projectId, context.projectId),
    eq(buildAgents.id, agentId),
  ]
  if (!options.includeArchived)
    predicates.push(eq(buildAgents.status, "active"))
  const rows = await database(context)
    .select()
    .from(buildAgents)
    .where(and(...predicates))
    .limit(1)
  if (!rows.length)
    throw new AgentNotFoundError(
      `Agent ${agentId} was not found in this project.`
    )
  return agentModel(rows[0])
}

export async function createAgent(
  context: BuildContext,
  input: CreateAgentInput
): Promise<ManagedAgent> {
  const name = requireName(input.name)
  const config = parseConfiguration(input.configuration ?? {})
  const now = new Date().toISOString()
  const id = input.id ?? randomUUID()
  const agent = {
    id,
    projectId: context.projectId,
    slug: normalizeSlug(input.slug, name),
    name,
    description: input.description?.trim() || null,
    status: "active" as const,
    currentRevision: 1,
    appliedRevision: 1,
    currentConfigJson: config,
    appliedConfigJson: config,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
  return database(context).transaction(async (tx) => {
    try {
      await tx.insert(buildAgents).values(agent)
      await tx.insert(buildAgentRevisions).values({
        id: randomUUID(),
        projectId: context.projectId,
        agentId: id,
        revision: 1,
        state: "applied",
        configJson: config,
        createdAt: now,
        createdBy: context.actorId ?? null,
      })
      if (input.cloneFromAgentId) {
        await cloneDefinitions(tx, context, input.cloneFromAgentId, id, now)
      }
      await createCatalogSnapshot(tx, context, id, 1)
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AgentConflictError(
          "An agent with this id or slug already exists in this project."
        )
      throw error
    }
    return agentModel(agent)
  })
}

export async function updateAgent(
  context: BuildContext,
  agentId: string,
  input: InternalSaveAgentInput
): Promise<ManagedAgent> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new AgentValidationError(
      "expectedRevision must be a positive integer."
    )
  }
  const db = database(context)
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(buildAgents)
      .where(
        and(
          eq(buildAgents.projectId, context.projectId),
          eq(buildAgents.id, agentId)
        )
      )
      .limit(1)
    const existing = existingRows[0]
    if (!existing)
      throw new AgentNotFoundError(
        `Agent ${agentId} was not found in this project.`
      )
    if (existing.currentRevision !== input.expectedRevision) {
      throw new AgentConflictError(
        `Agent changed at revision ${existing.currentRevision}; refresh before saving.`
      )
    }
    const config =
      input.configuration === undefined
        ? parseConfiguration(existing.currentConfigJson)
        : parseConfiguration(input.configuration)
    const nextRevision = existing.currentRevision + 1
    const apply = input.apply !== false
    const name =
      input.name === undefined ? existing.name : requireName(input.name)
    const nextSlug =
      input.slug === undefined ? existing.slug : normalizeSlug(input.slug, name)
    const now = new Date().toISOString()
    const values = {
      name,
      slug: nextSlug,
      description:
        input.description === undefined
          ? existing.description
          : input.description?.trim() || null,
      currentRevision: nextRevision,
      appliedRevision: apply ? nextRevision : existing.appliedRevision,
      currentConfigJson: config,
      appliedConfigJson: apply ? config : existing.appliedConfigJson,
      updatedAt: now,
    }
    const updated = await tx
      .update(buildAgents)
      .set(values)
      .where(
        and(
          eq(buildAgents.projectId, context.projectId),
          eq(buildAgents.id, agentId),
          eq(buildAgents.currentRevision, input.expectedRevision)
        )
      )
      .returning()
    if (!updated.length)
      throw new AgentConflictError(
        "Agent changed while saving; refresh before retrying."
      )
    try {
      await tx.insert(buildAgentRevisions).values({
        id: randomUUID(),
        projectId: context.projectId,
        agentId,
        revision: nextRevision,
        state: apply ? "applied" : "draft",
        configJson: config,
        createdAt: now,
        createdBy: context.actorId ?? null,
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AgentConflictError(
          "Agent revision already exists; refresh before retrying."
        )
      throw error
    }
    if (apply) {
      const catalogRevision =
        "catalogRevision" in input &&
        Number.isInteger(input.catalogRevision) &&
        input.catalogRevision !== undefined
          ? input.catalogRevision
          : undefined
      await createCatalogSnapshot(
        tx,
        context,
        agentId,
        nextRevision,
        catalogRevision
      )
    }
    return agentModel(updated[0])
  })
}

export async function cloneAgent(
  context: BuildContext,
  sourceAgentId: string,
  input: { name: string; slug?: string; id?: string }
): Promise<ManagedAgent> {
  const source = await getAgent(context, sourceAgentId, {
    includeArchived: true,
  })
  return createAgent(context, {
    id: input.id,
    name: input.name,
    slug: input.slug,
    description: source.description,
    configuration: source.configuration,
    cloneFromAgentId: source.id,
  })
}

export async function archiveAgent(
  context: BuildContext,
  agentId: string,
  expectedRevision: number
): Promise<ManagedAgent> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw new AgentValidationError(
      "expectedRevision must be a positive integer."
    )
  const now = new Date().toISOString()
  const updated = await database(context)
    .update(buildAgents)
    .set({ status: "archived", archivedAt: now, updatedAt: now })
    .where(
      and(
        eq(buildAgents.projectId, context.projectId),
        eq(buildAgents.id, agentId),
        eq(buildAgents.currentRevision, expectedRevision),
        eq(buildAgents.status, "active")
      )
    )
    .returning()
  if (!updated.length)
    throw new AgentConflictError(
      "Agent changed, archived, or was not found; refresh before archiving."
    )
  return agentModel(updated[0])
}

export async function listAgentRevisions(
  context: BuildContext,
  agentId: string
): Promise<AgentRevision[]> {
  await getAgent(context, agentId, { includeArchived: true })
  const rows = await database(context)
    .select()
    .from(buildAgentRevisions)
    .where(
      and(
        eq(buildAgentRevisions.projectId, context.projectId),
        eq(buildAgentRevisions.agentId, agentId)
      )
    )
    .orderBy(desc(buildAgentRevisions.revision))
  return rows.map(revisionModel)
}

export async function restoreAgentRevision(
  context: BuildContext,
  agentId: string,
  sourceRevision: number,
  expectedRevision: number
): Promise<ManagedAgent> {
  const sourceRows = await database(context)
    .select()
    .from(buildAgentRevisions)
    .where(
      and(
        eq(buildAgentRevisions.projectId, context.projectId),
        eq(buildAgentRevisions.agentId, agentId),
        eq(buildAgentRevisions.revision, sourceRevision)
      )
    )
    .limit(1)
  if (!sourceRows.length)
    throw new AgentNotFoundError(
      `Agent revision ${sourceRevision} was not found.`
    )
  return updateAgent(context, agentId, {
    expectedRevision,
    configuration: sourceRows[0].configJson,
    apply: true,
    catalogRevision: sourceRevision,
  })
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  )
}
