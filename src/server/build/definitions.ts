import { validateAppAction } from "./integrations/service"
import { randomUUID } from "node:crypto"

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { z } from "zod"

import {
  actionDefinitionSchema,
  procedureDefinitionSchema,
  widgetDefinitionSchema,
  type ActionDefinition,
  type ActionRecord,
  type ProcedureDefinition,
  type ProcedureRecord,
  type WidgetDefinition,
  type WidgetRecord,
} from "@/src/lib/build/contracts"
import {
  decryptProviderKey,
  encryptProviderKey,
} from "@/src/server/model-providers/secrets"
import type { BuildContext } from "./context"
import { skillActionSlugs } from "@/src/lib/build/skill-mentions"
import {
  buildActionRevisions,
  buildActions,
  buildAgentCatalogActions,
  buildAgentCatalogProcedures,
  buildAgentCatalogSnapshots,
  buildAgentCatalogWidgets,
  buildProcedureRevisions,
  buildProcedures,
  buildWidgetRevisions,
  buildWidgets,
  buildAgents,
  type BuildCatalogSchema,
} from "./catalog-schema"

type BuildDatabase = NodePgDatabase<BuildCatalogSchema>

function database(context: BuildContext): BuildDatabase {
  return context.database as unknown as BuildDatabase
}

/**
 * Header values are credentials by default. Header names are supplied by the
 * project author and therefore cannot safely classify whether a value is
 * public (for example, `X-Workspace`) or sensitive (for example, `X-Auth`).
 */
export const REDACTED_ACTION_HEADER = "[redacted]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function encryptActionHeaders(
  headers: Record<string, string>,
  projectId: string,
  actionId: string
) {
  return Object.keys(headers).length
    ? encryptProviderKey(
        JSON.stringify(headers),
        projectId,
        `build-action:${actionId}`
      )
    : null
}

export function decryptActionHeaders(
  encrypted: string,
  projectId: string,
  actionId: string
): Record<string, string> {
  const raw = decryptProviderKey(
    encrypted,
    projectId,
    `build-action:${actionId}`
  )
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value))
    throw new DefinitionValidationError("Encrypted action headers are invalid.")
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string")
      throw new DefinitionValidationError(
        "Encrypted action headers are invalid."
      )
    result[key] = item
  }
  return result
}

/** Return the catalog-safe form of an action definition. */
export function publicActionDefinition(
  definition: ActionDefinition
): ActionDefinition {
  if (definition.type !== "http") return definition
  return {
    ...definition,
    headers: Object.fromEntries(
      Object.keys(definition.headers).map((key) => [
        key,
        REDACTED_ACTION_HEADER,
      ])
    ),
  }
}

/**
 * Sanitize a previously persisted save-action result before returning it from
 * a receipt replay. This keeps old receipts safe even when they were created
 * before all action headers became encrypted.
 */
export function sanitizePublicActionResult(value: unknown): unknown {
  if (!isRecord(value) || !("definition" in value)) return value
  const definition = value.definition
  if (
    !isRecord(definition) ||
    definition.type !== "http" ||
    !isRecord(definition.headers)
  )
    return value
  return {
    ...value,
    definition: {
      ...definition,
      headers: Object.fromEntries(
        Object.keys(definition.headers).map((key) => [
          key,
          REDACTED_ACTION_HEADER,
        ])
      ),
    },
  }
}

type ActionRow = typeof buildActions.$inferSelect

type ActionCatalogRow = {
  id: string
  actionId?: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definitionJson: unknown
  encryptedHeaders: string | null
  createdAt: string
  updatedAt?: string
}

type ProcedureCatalogRow = {
  id: string
  procedureId?: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definitionJson: unknown
  createdAt: string
  updatedAt?: string
}

type WidgetCatalogRow = {
  id: string
  widgetId?: string
  projectId: string
  agentId: string
  slug: string
  revision: number
  definitionJson: unknown
  createdAt: string
  updatedAt?: string
}

function prepareActionDefinition(
  input: unknown,
  id: string,
  context: BuildContext,
  existing?: ActionRow
): { definition: ActionDefinition; encryptedHeaders: string | null } {
  if (!isRecord(input))
    throw new DefinitionValidationError("Action definition must be an object.")
  const oldDefinition = existing
    ? actionDefinitionSchema.parse(existing.definitionJson)
    : undefined
  const requestedType =
    typeof input.type === "string" ? input.type : oldDefinition?.type
  const oldHeaders = oldDefinition?.type === "http" ? oldDefinition.headers : {}
  const suppliedHeaders = isRecord(input.headers) ? input.headers : {}
  const preserveHeaders = requestedType === "http"
  const sourceHeaders = preserveHeaders
    ? { ...oldHeaders, ...suppliedHeaders }
    : suppliedHeaders
  let oldSecrets: Record<string, string> = {}
  if (preserveHeaders && existing?.encryptedHeaders)
    oldSecrets = decryptActionHeaders(
      existing.encryptedHeaders,
      context.projectId,
      id
    )
  const secrets = { ...oldSecrets }
  const publicHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (value === REDACTED_ACTION_HEADER) {
      if (!secrets[key])
        throw new DefinitionValidationError(
          `Header ${key} cannot be redacted on a new action.`
        )
      publicHeaders[key] = REDACTED_ACTION_HEADER
    } else if (typeof value === "string") {
      secrets[key] = value
      publicHeaders[key] = REDACTED_ACTION_HEADER
    } else {
      throw new DefinitionValidationError(
        `Action header ${key} must be a string.`
      )
    }
  }
  try {
    const definition = actionDefinitionSchema.parse({
      ...input,
      id,
      ...(preserveHeaders ? { headers: publicHeaders } : {}),
    })
    return {
      definition,
      encryptedHeaders: preserveHeaders
        ? encryptActionHeaders(secrets, context.projectId, id)
        : null,
    }
  } catch (error) {
    throw validation(error)
  }
}

export class DefinitionNotFoundError extends Error {
  readonly code = "NOT_FOUND"
}

export class DefinitionConflictError extends Error {
  readonly code = "CONFLICT"
}

export class DefinitionValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
}

function validation(error: unknown): DefinitionValidationError {
  return new DefinitionValidationError(
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : String(error)
  )
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  )
}

function slug(value: string | undefined, fallback: string): string {
  const candidate =
    value === undefined
      ? fallback
          .trim()
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 120) || "definition"
      : value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/.test(candidate)) {
    throw new DefinitionValidationError(
      "Definition slugs must use lowercase letters, numbers, hyphens or underscores."
    )
  }
  return candidate
}

async function assertAgent(context: BuildContext, agentId: string) {
  const rows = await database(context)
    .select({ id: buildAgents.id })
    .from(buildAgents)
    .where(
      and(
        eq(buildAgents.projectId, context.projectId),
        eq(buildAgents.id, agentId)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new DefinitionNotFoundError(
      `Agent ${agentId} was not found in this project.`
    )
}

async function assertActionReferences(
  context: BuildContext,
  agentId: string,
  actionIds: string[]
) {
  const ids = [...new Set(actionIds.filter(Boolean))]
  if (!ids.length) return
  const rows = await database(context)
    .select({ id: buildActions.id })
    .from(buildActions)
    .where(
      and(
        eq(buildActions.projectId, context.projectId),
        eq(buildActions.agentId, agentId),
        inArray(buildActions.id, ids),
        isNull(buildActions.deletedAt)
      )
    )
  if (rows.length !== ids.length) {
    const existing = new Set(rows.map((row) => row.id))
    const missing = ids.find((id) => !existing.has(id))
    throw new DefinitionValidationError(
      `Definition references action ${missing ?? "unknown"}, which is not active for this agent.`
    )
  }
}

async function assertWidgetReference(
  context: BuildContext,
  agentId: string,
  widgetId: string
) {
  const rows = await database(context)
    .select({ id: buildWidgets.id })
    .from(buildWidgets)
    .where(
      and(
        eq(buildWidgets.projectId, context.projectId),
        eq(buildWidgets.agentId, agentId),
        eq(buildWidgets.id, widgetId),
        isNull(buildWidgets.deletedAt)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new DefinitionValidationError(
      `Action references widget ${widgetId}, which is not active for this agent.`
    )
}

function actionRecord(row: ActionCatalogRow): ActionRecord {
  const definition = actionDefinitionSchema.parse(row.definitionJson)
  return {
    // Current rows use `id` as the definition id. Revision rows have their
    // own immutable row id and carry the stable definition id in actionId.
    id: row.actionId ?? row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    slug: row.slug,
    revision: row.revision,
    definition: publicActionDefinition(definition),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

/**
 * Resolve an action for a trusted runtime worker. HTTP credentials are kept
 * encrypted in the catalog and are only decrypted at this explicit boundary;
 * ordinary list/get/revision APIs intentionally return the redacted public
 * definition from `definitionJson`.
 */
function runtimeActionRecord(row: ActionCatalogRow): ActionRecord {
  const definition = actionDefinitionSchema.parse(row.definitionJson)
  const record = actionRecord(row)
  if (definition.type !== "http") return record
  return {
    ...record,
    definition: {
      ...definition,
      headers: {
        ...definition.headers,
        ...(row.encryptedHeaders
          ? decryptActionHeaders(
              row.encryptedHeaders,
              row.projectId,
              row.actionId ?? row.id
            )
          : {}),
      },
    },
  }
}

function procedureRecord(row: ProcedureCatalogRow): ProcedureRecord {
  return {
    id: row.procedureId ?? row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    slug: row.slug,
    revision: row.revision,
    definition: procedureDefinitionSchema.parse(row.definitionJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

function widgetRecord(row: WidgetCatalogRow): WidgetRecord {
  return {
    id: row.widgetId ?? row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    slug: row.slug,
    revision: row.revision,
    definition: widgetDefinitionSchema.parse(row.definitionJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  }
}

export type AppliedAgentDefinitions = {
  projectId: string
  agentId: string
  agentRevision: number
  actions: ActionRecord[]
  procedures: ProcedureRecord[]
  widgets: WidgetRecord[]
}

/**
 * Load the immutable definition bundle selected by the agent's applied
 * revision. This is the only bulk definition read intended for customer
 * runtime workers. It never follows editable current rows, and it decrypts
 * HTTP action headers only after the snapshot has been proven to belong to
 * this project and agent.
 */
export async function getRuntimeAppliedDefinitions(
  context: BuildContext,
  agentId: string,
  appliedRevision?: number
): Promise<AppliedAgentDefinitions> {
  if (
    appliedRevision !== undefined &&
    (!Number.isInteger(appliedRevision) || appliedRevision < 1)
  )
    throw new DefinitionValidationError(
      "An applied agent revision must be a positive integer."
    )

  const db = database(context)
  const agentRows = await db
    .select({
      id: buildAgents.id,
      appliedRevision: buildAgents.appliedRevision,
    })
    .from(buildAgents)
    .where(
      and(
        eq(buildAgents.projectId, context.projectId),
        eq(buildAgents.id, agentId),
        eq(buildAgents.status, "active")
      )
    )
    .limit(1)
  const agent = agentRows[0]
  if (!agent)
    throw new DefinitionNotFoundError(
      `Agent ${agentId} was not found in this project.`
    )
  const selectedRevision = appliedRevision ?? agent.appliedRevision

  const snapshotRows = await db
    .select({
      id: buildAgentCatalogSnapshots.id,
      agentRevision: buildAgentCatalogSnapshots.agentRevision,
    })
    .from(buildAgentCatalogSnapshots)
    .where(
      and(
        eq(buildAgentCatalogSnapshots.projectId, context.projectId),
        eq(buildAgentCatalogSnapshots.agentId, agentId),
        eq(buildAgentCatalogSnapshots.agentRevision, selectedRevision)
      )
    )
    .limit(1)
  const snapshot = snapshotRows[0]
  if (!snapshot) {
    throw new DefinitionConflictError(
      `Agent ${agentId} applied revision ${selectedRevision} has no definition catalog snapshot.`
    )
  }

  const [actionRefs, procedureRefs, widgetRefs] = await Promise.all([
    db
      .select({
        actionId: buildAgentCatalogActions.actionId,
        revision: buildAgentCatalogActions.revision,
      })
      .from(buildAgentCatalogActions)
      .where(
        and(
          eq(buildAgentCatalogActions.projectId, context.projectId),
          eq(buildAgentCatalogActions.catalogId, snapshot.id)
        )
      ),
    db
      .select({
        procedureId: buildAgentCatalogProcedures.procedureId,
        revision: buildAgentCatalogProcedures.revision,
      })
      .from(buildAgentCatalogProcedures)
      .where(
        and(
          eq(buildAgentCatalogProcedures.projectId, context.projectId),
          eq(buildAgentCatalogProcedures.catalogId, snapshot.id)
        )
      ),
    db
      .select({
        widgetId: buildAgentCatalogWidgets.widgetId,
        revision: buildAgentCatalogWidgets.revision,
      })
      .from(buildAgentCatalogWidgets)
      .where(
        and(
          eq(buildAgentCatalogWidgets.projectId, context.projectId),
          eq(buildAgentCatalogWidgets.catalogId, snapshot.id)
        )
      ),
  ])

  const actionRows = actionRefs.length
    ? await db
        .select()
        .from(buildActionRevisions)
        .where(
          and(
            eq(buildActionRevisions.projectId, context.projectId),
            eq(buildActionRevisions.agentId, agentId),
            inArray(
              buildActionRevisions.actionId,
              actionRefs.map((ref) => ref.actionId)
            )
          )
        )
    : []
  const procedureRows = procedureRefs.length
    ? await db
        .select()
        .from(buildProcedureRevisions)
        .where(
          and(
            eq(buildProcedureRevisions.projectId, context.projectId),
            eq(buildProcedureRevisions.agentId, agentId),
            inArray(
              buildProcedureRevisions.procedureId,
              procedureRefs.map((ref) => ref.procedureId)
            )
          )
        )
    : []
  const widgetRows = widgetRefs.length
    ? await db
        .select()
        .from(buildWidgetRevisions)
        .where(
          and(
            eq(buildWidgetRevisions.projectId, context.projectId),
            eq(buildWidgetRevisions.agentId, agentId),
            inArray(
              buildWidgetRevisions.widgetId,
              widgetRefs.map((ref) => ref.widgetId)
            )
          )
        )
    : []

  const actionByKey = new Map(
    actionRows.map((row) => [`${row.actionId}:${row.revision}`, row])
  )
  const procedureByKey = new Map(
    procedureRows.map((row) => [`${row.procedureId}:${row.revision}`, row])
  )
  const widgetByKey = new Map(
    widgetRows.map((row) => [`${row.widgetId}:${row.revision}`, row])
  )
  const missing = (kind: string, id: string, revision: number) =>
    new DefinitionConflictError(
      `Applied agent revision references missing ${kind} ${id} revision ${revision}.`
    )

  const actions = actionRefs.map((ref) => {
    const row = actionByKey.get(`${ref.actionId}:${ref.revision}`)
    if (!row) throw missing("action", ref.actionId, ref.revision)
    return runtimeActionRecord(row)
  })
  const procedures = procedureRefs.map((ref) => {
    const row = procedureByKey.get(`${ref.procedureId}:${ref.revision}`)
    if (!row) throw missing("procedure", ref.procedureId, ref.revision)
    return procedureRecord(row)
  })
  const widgets = widgetRefs.map((ref) => {
    const row = widgetByKey.get(`${ref.widgetId}:${ref.revision}`)
    if (!row) throw missing("widget", ref.widgetId, ref.revision)
    return widgetRecord(row)
  })

  actions.sort((left, right) => left.slug.localeCompare(right.slug))
  procedures.sort((left, right) => left.slug.localeCompare(right.slug))
  widgets.sort((left, right) => left.slug.localeCompare(right.slug))
  return {
    projectId: context.projectId,
    agentId,
    agentRevision: snapshot.agentRevision,
    actions,
    procedures,
    widgets,
  }
}

export type SaveActionInput = {
  id?: string
  slug?: string
  definition: unknown
  expectedRevision?: number
}

export async function listActions(
  context: BuildContext,
  agentId: string
): Promise<ActionRecord[]> {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildActions)
    .where(
      and(
        eq(buildActions.projectId, context.projectId),
        eq(buildActions.agentId, agentId),
        isNull(buildActions.deletedAt)
      )
    )
    .orderBy(asc(buildActions.slug))
  return rows.map(actionRecord)
}

export async function getAction(
  context: BuildContext,
  agentId: string,
  actionId: string
): Promise<ActionRecord> {
  const rows = await database(context)
    .select()
    .from(buildActions)
    .where(
      and(
        eq(buildActions.projectId, context.projectId),
        eq(buildActions.agentId, agentId),
        eq(buildActions.id, actionId),
        isNull(buildActions.deletedAt)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new DefinitionNotFoundError(`Action ${actionId} was not found.`)
  return actionRecord(rows[0])
}

/** Read one action with HTTP credentials restored for the trusted runtime. */
export async function getRuntimeAction(
  context: BuildContext,
  agentId: string,
  actionId: string
): Promise<ActionRecord> {
  const bundle = await getRuntimeAppliedDefinitions(context, agentId)
  const action = bundle.actions.find((candidate) => candidate.id === actionId)
  if (!action)
    throw new DefinitionNotFoundError(
      `Action ${actionId} is not part of the applied agent revision.`
    )
  return action
}

/** Read all active actions with HTTP credentials for the trusted runtime. */
export async function getRuntimeActionDefinitions(
  context: BuildContext,
  agentId: string
): Promise<ActionRecord[]> {
  return (await getRuntimeAppliedDefinitions(context, agentId)).actions
}

export async function saveAction(
  context: BuildContext,
  agentId: string,
  input: SaveActionInput
): Promise<ActionRecord> {
  await assertAgent(context, agentId)
  const id = input.id ?? randomUUID()
  const now = new Date().toISOString()
  const db = database(context)
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(buildActions)
      .where(
        and(
          eq(buildActions.projectId, context.projectId),
          eq(buildActions.agentId, agentId),
          eq(buildActions.id, id)
        )
      )
      .limit(1)
    const existing = existingRows[0]
    const prepared = prepareActionDefinition(
      input.definition,
      id,
      context,
      existing
    )
    const { definition, encryptedHeaders } = prepared
    if (definition.type === "integration") {
      const tool = await validateAppAction(
        context,
        definition.connectionId,
        definition.toolSlug
      )
      definition.inputSchema =
        tool.inputSchema as ActionDefinition["inputSchema"]
    }
    if (definition.type === "form" && definition.submitActionId)
      await assertActionReferences(context, agentId, [
        definition.submitActionId,
      ])
    if (definition.type === "widget")
      await assertWidgetReference(context, agentId, definition.widgetId)
    if (!existing) {
      if (input.expectedRevision !== undefined)
        throw new DefinitionConflictError(
          "A new action cannot specify an expected revision."
        )
      const row = {
        id,
        projectId: context.projectId,
        agentId,
        slug: slug(input.slug, definition.name),
        revision: 1,
        definitionJson: definition,
        encryptedHeaders,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      try {
        await tx.insert(buildActions).values(row)
        await tx.insert(buildActionRevisions).values({
          id: randomUUID(),
          projectId: context.projectId,
          actionId: id,
          agentId,
          slug: row.slug,
          revision: 1,
          definitionJson: definition,
          encryptedHeaders,
          createdAt: now,
          createdBy: context.actorId ?? null,
        })
      } catch (error) {
        if (isUniqueViolation(error))
          throw new DefinitionConflictError(
            "An action with this id or slug already exists for this agent."
          )
        throw error
      }
      return actionRecord(row)
    }
    if (existing.deletedAt)
      throw new DefinitionNotFoundError(`Action ${id} was deleted.`)
    if (input.expectedRevision === undefined)
      throw new DefinitionConflictError(
        "Updating an action requires expectedRevision."
      )
    const nextRevision = existing.revision + 1
    let updated: Array<typeof buildActions.$inferSelect>
    try {
      updated = await tx
        .update(buildActions)
        .set({
          slug: slug(input.slug, existing.slug),
          revision: nextRevision,
          definitionJson: definition,
          encryptedHeaders,
          updatedAt: now,
        })
        .where(
          and(
            eq(buildActions.projectId, context.projectId),
            eq(buildActions.agentId, agentId),
            eq(buildActions.id, id),
            eq(buildActions.revision, input.expectedRevision)
          )
        )
        .returning()
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DefinitionConflictError(
          "An action with this slug already exists for this agent."
        )
      throw error
    }
    if (!updated.length)
      throw new DefinitionConflictError(
        "Action changed since it was loaded; refresh before saving."
      )
    try {
      await tx.insert(buildActionRevisions).values({
        id: randomUUID(),
        projectId: context.projectId,
        actionId: id,
        agentId,
        slug: updated[0].slug,
        revision: nextRevision,
        definitionJson: definition,
        encryptedHeaders,
        createdAt: now,
        createdBy: context.actorId ?? null,
      })
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DefinitionConflictError(
          "Action revision already exists; refresh before retrying."
        )
      throw error
    }
    return actionRecord(updated[0])
  })
}

export async function listActionRevisions(
  context: BuildContext,
  agentId: string,
  actionId: string
) {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildActionRevisions)
    .where(
      and(
        eq(buildActionRevisions.projectId, context.projectId),
        eq(buildActionRevisions.agentId, agentId),
        eq(buildActionRevisions.actionId, actionId)
      )
    )
    .orderBy(desc(buildActionRevisions.revision))
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    actionId: row.actionId,
    slug: row.slug,
    revision: row.revision,
    definition: publicActionDefinition(
      actionDefinitionSchema.parse(row.definitionJson)
    ),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }))
}

function procedureReferencesAction(
  definitionJson: unknown,
  actionId: string
): boolean {
  try {
    const definition = procedureDefinitionSchema.parse(definitionJson)
    return [
      ...definition.actionRefs,
      ...definition.steps.flatMap((step) =>
        "actionId" in step ? [step.actionId] : []
      ),
      ...definition.branches.flatMap((branch) =>
        branch.steps.flatMap((step) =>
          "actionId" in step ? [step.actionId] : []
        )
      ),
    ].includes(actionId)
  } catch {
    // Invalid legacy definitions are treated as referenced so cleanup cannot
    // silently remove a dependency that a runtime worker may still inspect.
    return true
  }
}

function widgetReferencesAction(
  definitionJson: unknown,
  actionId: string
): boolean {
  try {
    const definition = widgetDefinitionSchema.parse(definitionJson)
    return [
      ...definition.functions.flatMap((fn) =>
        fn.actionId ? [fn.actionId] : []
      ),
      ...definition.components.flatMap((component) => {
        if (component.type === "button") return [component.actionId]
        if (component.type === "form") return [component.submitActionId]
        if (component.type === "card" && component.actionId)
          return [component.actionId]
        return []
      }),
    ].includes(actionId)
  } catch {
    return true
  }
}

function actionReferencesAction(
  definitionJson: unknown,
  actionId: string
): boolean {
  try {
    const definition = actionDefinitionSchema.parse(definitionJson)
    return definition.type === "form" && definition.submitActionId === actionId
  } catch {
    return true
  }
}

export async function deleteAction(
  context: BuildContext,
  agentId: string,
  actionId: string,
  expectedRevision: number
): Promise<void> {
  await assertAgent(context, agentId)
  await database(context).transaction(async (tx) => {
    const [procedures, widgets, actions] = await Promise.all([
      tx
        .select({ definitionJson: buildProcedures.definitionJson })
        .from(buildProcedures)
        .where(
          and(
            eq(buildProcedures.projectId, context.projectId),
            eq(buildProcedures.agentId, agentId),
            isNull(buildProcedures.deletedAt)
          )
        ),
      tx
        .select({ definitionJson: buildWidgets.definitionJson })
        .from(buildWidgets)
        .where(
          and(
            eq(buildWidgets.projectId, context.projectId),
            eq(buildWidgets.agentId, agentId),
            isNull(buildWidgets.deletedAt)
          )
        ),
      tx
        .select({ definitionJson: buildActions.definitionJson })
        .from(buildActions)
        .where(
          and(
            eq(buildActions.projectId, context.projectId),
            eq(buildActions.agentId, agentId),
            isNull(buildActions.deletedAt)
          )
        ),
    ])
    if (
      procedures.some((row) =>
        procedureReferencesAction(row.definitionJson, actionId)
      ) ||
      widgets.some((row) =>
        widgetReferencesAction(row.definitionJson, actionId)
      ) ||
      actions.some((row) =>
        actionReferencesAction(row.definitionJson, actionId)
      )
    ) {
      throw new DefinitionConflictError(
        "Action is referenced by an active definition; remove the references before deleting it."
      )
    }
    const updated = await tx
      .update(buildActions)
      .set({
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(buildActions.projectId, context.projectId),
          eq(buildActions.agentId, agentId),
          eq(buildActions.id, actionId),
          eq(buildActions.revision, expectedRevision),
          isNull(buildActions.deletedAt)
        )
      )
      .returning({ id: buildActions.id })
    if (!updated.length)
      throw new DefinitionConflictError(
        "Action changed, deleted, or was not found; refresh before deleting."
      )
  })
}

export type SaveProcedureInput = {
  id?: string
  slug?: string
  definition: unknown
  expectedRevision?: number
}

export async function listProcedures(
  context: BuildContext,
  agentId: string
): Promise<ProcedureRecord[]> {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildProcedures)
    .where(
      and(
        eq(buildProcedures.projectId, context.projectId),
        eq(buildProcedures.agentId, agentId),
        isNull(buildProcedures.deletedAt)
      )
    )
    .orderBy(asc(buildProcedures.slug))
  return rows.map(procedureRecord)
}

export async function getProcedure(
  context: BuildContext,
  agentId: string,
  procedureId: string
): Promise<ProcedureRecord> {
  const rows = await database(context)
    .select()
    .from(buildProcedures)
    .where(
      and(
        eq(buildProcedures.projectId, context.projectId),
        eq(buildProcedures.agentId, agentId),
        eq(buildProcedures.id, procedureId),
        isNull(buildProcedures.deletedAt)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new DefinitionNotFoundError(`Procedure ${procedureId} was not found.`)
  return procedureRecord(rows[0])
}

export async function saveProcedure(
  context: BuildContext,
  agentId: string,
  input: SaveProcedureInput
): Promise<ProcedureRecord> {
  await assertAgent(context, agentId)
  const id = input.id ?? randomUUID()
  let definition: ProcedureDefinition
  try {
    definition = procedureDefinitionSchema.parse(input.definition)
  } catch (error) {
    throw validation(error)
  }
  if (definition.instructions?.trim()) {
    const slugs = skillActionSlugs(definition.instructions)
    if (slugs.length > 100)
      throw new DefinitionValidationError("A skill can mention at most 100 actions.")
    const actions = slugs.length ? await listActions(context, agentId) : []
    const bySlug = new Map(actions.map(action => [action.slug, action.id]))
    definition.actionRefs = slugs.map(slug => {
      const id = bySlug.get(slug)
      if (!id) throw new DefinitionValidationError(`Mentioned action @${slug} is not available on this agent.`)
      return id
    })
  }
  await assertActionReferences(context, agentId, [
    ...definition.actionRefs,
    ...definition.steps.flatMap((step) =>
      "actionId" in step ? [step.actionId] : []
    ),
    ...definition.branches.flatMap((branch) =>
      branch.steps.flatMap((step) =>
        "actionId" in step ? [step.actionId] : []
      )
    ),
  ])
  const now = new Date().toISOString()
  return database(context).transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(buildProcedures)
      .where(
        and(
          eq(buildProcedures.projectId, context.projectId),
          eq(buildProcedures.agentId, agentId),
          eq(buildProcedures.id, id)
        )
      )
      .limit(1)
    const existing = existingRows[0]
    if (!existing) {
      if (input.expectedRevision !== undefined)
        throw new DefinitionConflictError(
          "A new procedure cannot specify an expected revision."
        )
      const row = {
        id,
        projectId: context.projectId,
        agentId,
        slug: slug(input.slug, definition.name),
        revision: 1,
        definitionJson: definition,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      await tx.insert(buildProcedures).values(row)
      await tx.insert(buildProcedureRevisions).values({
        id: randomUUID(),
        projectId: context.projectId,
        procedureId: id,
        agentId,
        slug: row.slug,
        revision: 1,
        definitionJson: definition,
        createdAt: now,
        createdBy: context.actorId ?? null,
      })
      return procedureRecord(row)
    }
    if (existing.deletedAt)
      throw new DefinitionNotFoundError(`Procedure ${id} was deleted.`)
    if (input.expectedRevision === undefined)
      throw new DefinitionConflictError(
        "Updating a procedure requires expectedRevision."
      )
    const nextRevision = existing.revision + 1
    const updated = await tx
      .update(buildProcedures)
      .set({
        slug: slug(input.slug, existing.slug),
        revision: nextRevision,
        definitionJson: definition,
        updatedAt: now,
      })
      .where(
        and(
          eq(buildProcedures.projectId, context.projectId),
          eq(buildProcedures.agentId, agentId),
          eq(buildProcedures.id, id),
          eq(buildProcedures.revision, input.expectedRevision)
        )
      )
      .returning()
    if (!updated.length)
      throw new DefinitionConflictError(
        "Procedure changed since it was loaded; refresh before saving."
      )
    await tx.insert(buildProcedureRevisions).values({
      id: randomUUID(),
      projectId: context.projectId,
      procedureId: id,
      agentId,
      slug: updated[0].slug,
      revision: nextRevision,
      definitionJson: definition,
      createdAt: now,
      createdBy: context.actorId ?? null,
    })
    return procedureRecord(updated[0])
  })
}

export async function listProcedureRevisions(
  context: BuildContext,
  agentId: string,
  procedureId: string
) {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildProcedureRevisions)
    .where(
      and(
        eq(buildProcedureRevisions.projectId, context.projectId),
        eq(buildProcedureRevisions.agentId, agentId),
        eq(buildProcedureRevisions.procedureId, procedureId)
      )
    )
    .orderBy(desc(buildProcedureRevisions.revision))
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    procedureId: row.procedureId,
    slug: row.slug,
    revision: row.revision,
    definition: procedureDefinitionSchema.parse(row.definitionJson),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }))
}

export async function deleteProcedure(
  context: BuildContext,
  agentId: string,
  procedureId: string,
  expectedRevision: number
): Promise<void> {
  await assertAgent(context, agentId)
  await database(context).transaction(async (tx) => {
    const now = new Date().toISOString()
    const updated = await tx
      .update(buildProcedures)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(buildProcedures.projectId, context.projectId),
          eq(buildProcedures.agentId, agentId),
          eq(buildProcedures.id, procedureId),
          eq(buildProcedures.revision, expectedRevision),
          isNull(buildProcedures.deletedAt)
        )
      )
      .returning({ id: buildProcedures.id })
    if (!updated.length)
      throw new DefinitionConflictError(
        "Procedure changed, deleted, or was not found; refresh before deleting."
      )
  })
}

export type SaveWidgetInput = {
  id?: string
  slug?: string
  definition: unknown
  expectedRevision?: number
}

export async function listWidgets(
  context: BuildContext,
  agentId: string
): Promise<WidgetRecord[]> {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildWidgets)
    .where(
      and(
        eq(buildWidgets.projectId, context.projectId),
        eq(buildWidgets.agentId, agentId),
        isNull(buildWidgets.deletedAt)
      )
    )
    .orderBy(asc(buildWidgets.slug))
  return rows.map(widgetRecord)
}

export async function getWidget(
  context: BuildContext,
  agentId: string,
  widgetId: string
): Promise<WidgetRecord> {
  const rows = await database(context)
    .select()
    .from(buildWidgets)
    .where(
      and(
        eq(buildWidgets.projectId, context.projectId),
        eq(buildWidgets.agentId, agentId),
        eq(buildWidgets.id, widgetId),
        isNull(buildWidgets.deletedAt)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new DefinitionNotFoundError(`Widget ${widgetId} was not found.`)
  return widgetRecord(rows[0])
}

export async function saveWidget(
  context: BuildContext,
  agentId: string,
  input: SaveWidgetInput
): Promise<WidgetRecord> {
  await assertAgent(context, agentId)
  const id = input.id ?? randomUUID()
  let definition: WidgetDefinition
  try {
    definition = widgetDefinitionSchema.parse(input.definition)
    if (definition.code) {
      const { compileWidgetCode, compileWidgetSchema } =
        await import("@/src/lib/build/widget-compiler")
      compileWidgetCode(definition.code)
      if (definition.schemaCode) compileWidgetSchema(definition.schemaCode)
    }
  } catch (error) {
    throw validation(error)
  }
  await assertActionReferences(context, agentId, [
    ...definition.functions.flatMap((fn) => (fn.actionId ? [fn.actionId] : [])),
    ...definition.components.flatMap((component) => {
      if (component.type === "button") return [component.actionId]
      if (component.type === "form") return [component.submitActionId]
      if (component.type === "card" && component.actionId)
        return [component.actionId]
      return []
    }),
  ])
  const now = new Date().toISOString()
  return database(context).transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(buildWidgets)
      .where(
        and(
          eq(buildWidgets.projectId, context.projectId),
          eq(buildWidgets.agentId, agentId),
          eq(buildWidgets.id, id)
        )
      )
      .limit(1)
    const existing = existingRows[0]
    if (!existing) {
      if (input.expectedRevision !== undefined)
        throw new DefinitionConflictError(
          "A new widget cannot specify an expected revision."
        )
      const row = {
        id,
        projectId: context.projectId,
        agentId,
        slug: slug(input.slug, definition.name),
        revision: 1,
        definitionJson: definition,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      await tx.insert(buildWidgets).values(row)
      await tx.insert(buildWidgetRevisions).values({
        id: randomUUID(),
        projectId: context.projectId,
        widgetId: id,
        agentId,
        slug: row.slug,
        revision: 1,
        definitionJson: definition,
        createdAt: now,
        createdBy: context.actorId ?? null,
      })
      return widgetRecord(row)
    }
    if (existing.deletedAt)
      throw new DefinitionNotFoundError(`Widget ${id} was deleted.`)
    if (input.expectedRevision === undefined)
      throw new DefinitionConflictError(
        "Updating a widget requires expectedRevision."
      )
    const nextRevision = existing.revision + 1
    const updated = await tx
      .update(buildWidgets)
      .set({
        slug: slug(input.slug, existing.slug),
        revision: nextRevision,
        definitionJson: definition,
        updatedAt: now,
      })
      .where(
        and(
          eq(buildWidgets.projectId, context.projectId),
          eq(buildWidgets.agentId, agentId),
          eq(buildWidgets.id, id),
          eq(buildWidgets.revision, input.expectedRevision)
        )
      )
      .returning()
    if (!updated.length)
      throw new DefinitionConflictError(
        "Widget changed since it was loaded; refresh before saving."
      )
    await tx.insert(buildWidgetRevisions).values({
      id: randomUUID(),
      projectId: context.projectId,
      widgetId: id,
      agentId,
      slug: updated[0].slug,
      revision: nextRevision,
      definitionJson: definition,
      createdAt: now,
      createdBy: context.actorId ?? null,
    })
    return widgetRecord(updated[0])
  })
}

export async function listWidgetRevisions(
  context: BuildContext,
  agentId: string,
  widgetId: string
) {
  await assertAgent(context, agentId)
  const rows = await database(context)
    .select()
    .from(buildWidgetRevisions)
    .where(
      and(
        eq(buildWidgetRevisions.projectId, context.projectId),
        eq(buildWidgetRevisions.agentId, agentId),
        eq(buildWidgetRevisions.widgetId, widgetId)
      )
    )
    .orderBy(desc(buildWidgetRevisions.revision))
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    widgetId: row.widgetId,
    slug: row.slug,
    revision: row.revision,
    definition: widgetDefinitionSchema.parse(row.definitionJson),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }))
}

export async function deleteWidget(
  context: BuildContext,
  agentId: string,
  widgetId: string,
  expectedRevision: number
): Promise<void> {
  await assertAgent(context, agentId)
  await database(context).transaction(async (tx) => {
    const actions = await tx
      .select({ definitionJson: buildActions.definitionJson })
      .from(buildActions)
      .where(
        and(
          eq(buildActions.projectId, context.projectId),
          eq(buildActions.agentId, agentId),
          isNull(buildActions.deletedAt)
        )
      )
    if (
      actions.some((row) => {
        try {
          const definition = actionDefinitionSchema.parse(row.definitionJson)
          return (
            definition.type === "widget" && definition.widgetId === widgetId
          )
        } catch {
          return true
        }
      })
    ) {
      throw new DefinitionConflictError(
        "Widget is referenced by an active action; remove the reference before deleting it."
      )
    }
    const now = new Date().toISOString()
    const updated = await tx
      .update(buildWidgets)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(buildWidgets.projectId, context.projectId),
          eq(buildWidgets.agentId, agentId),
          eq(buildWidgets.id, widgetId),
          eq(buildWidgets.revision, expectedRevision),
          isNull(buildWidgets.deletedAt)
        )
      )
      .returning({ id: buildWidgets.id })
    if (!updated.length)
      throw new DefinitionConflictError(
        "Widget changed, deleted, or was not found; refresh before deleting."
      )
  })
}
