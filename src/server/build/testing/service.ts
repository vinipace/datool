import { randomUUID } from "node:crypto"

import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { z } from "zod"

import {
  observedActionSchema,
  simulationConfigSnapshotSchema,
  simulationDefinitionSchema,
  simulationMessageSchema,
  simulationVerdictSchema,
  toolMockSchema,
  type ExpectedAction,
  type ObservedAction,
  type SimulationCaseRecord,
  type SimulationConfigSnapshot,
  type SimulationDefinition,
  type SimulationDefinitionRecord,
  type SimulationMessage,
  type SimulationRunRecord,
  type SimulationVerdict,
  type ToolMock,
} from "@/src/lib/build/testing"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import { getAgent } from "../agents"
import { listActions, listProcedures, listWidgets } from "../definitions"
import type { BuildContext } from "../context"
import {
  buildTestCases,
  buildTestDefinitionRevisions,
  buildTestDefinitions,
  buildTestRuns,
  buildTestToolMocks,
  type BuildTestingSchema,
} from "./schema"

type BuildTestingDatabase = NodePgDatabase<BuildTestingSchema>

function database(context: BuildContext): BuildTestingDatabase {
  return context.database as unknown as BuildTestingDatabase
}

function now() {
  return new Date()
}

function iso(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

function isSnapshotSecretKey(key: string) {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLocaleLowerCase()
  return /(?:^|[_-])(api[_-]?key|authorization|credential|password|secret|token|private[_-]?key|signing[_-]?key)$/.test(
    normalized
  )
}

function redactSnapshotSecrets(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redactSnapshotSecrets)
  if (!value || typeof value !== "object") return value as JsonValue
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (isSnapshotSecretKey(key)) return [key, "__REDACTED__"]
      return [key, redactSnapshotSecrets(child)]
    })
  ) as JsonValue
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

export class SimulationNotFoundError extends Error {
  readonly code = "NOT_FOUND"
}

export class SimulationConflictError extends Error {
  readonly code = "CONFLICT"
}

export class SimulationValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
}

export class SimulationLeaseError extends Error {
  readonly code = "CONFLICT"
}

function parseDefinition(value: unknown): SimulationDefinition {
  try {
    return simulationDefinitionSchema.parse(value)
  } catch (error) {
    throw new SimulationValidationError(
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : String(error)
    )
  }
}

function definitionModel(
  row: typeof buildTestDefinitions.$inferSelect
): SimulationDefinitionRecord {
  const definition = parseDefinition(row.definitionJson)
  return {
    ...definition,
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    revision: row.revision,
    status: row.status as SimulationDefinitionRecord["status"],
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    createdBy: row.createdBy,
  }
}

function transcript(value: unknown): SimulationMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = simulationMessageSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function observedActions(value: unknown): ObservedAction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const parsed = observedActionSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

function runModel(row: typeof buildTestRuns.$inferSelect): SimulationRunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    definitionId: row.definitionId,
    status: row.status,
    requestedCases: row.requestedCases,
    completedCases: row.completedCases,
    passedCases: row.passedCases,
    failedCases: row.failedCases,
    noVerdictCases: row.noVerdictCases,
    infraErrorCases: row.infraErrorCases,
    configSnapshot: simulationConfigSnapshotSchema.parse(
      row.configSnapshotJson
    ),
    createdAt: iso(row.createdAt)!,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    error: row.error,
    requestedBy: row.requestedBy,
  }
}

function caseModel(
  row: typeof buildTestCases.$inferSelect
): SimulationCaseRecord {
  const parsedVerdict =
    row.verdictJson === null
      ? null
      : simulationVerdictSchema.safeParse(row.verdictJson)
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    ordinal: row.ordinal,
    repeatIndex: row.repeatIndex,
    variantKey: row.variantKey,
    model: row.model,
    status: row.status,
    transcript: transcript(row.transcriptJson),
    observedActions: observedActions(row.observedActionsJson),
    verdict: parsedVerdict?.success ? parsedVerdict.data : null,
    error: row.error,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  }
}

export type SimulationConfigSnapshotLoader = (
  context: BuildContext,
  agentId: string
) => Promise<SimulationConfigSnapshot>

/**
 * Captures every mutable Build input used by a simulation. The captured JSON is
 * persisted on the run and is the only configuration the worker is allowed to
 * read while executing its cases.
 */
export async function captureSimulationConfig(
  context: BuildContext,
  agentId: string
): Promise<SimulationConfigSnapshot> {
  const agent = await getAgent(context, agentId, { includeArchived: true })
  const [actions, procedures, widgets, knowledgeSources, knowledgeChunks] =
    await Promise.all([
      listActions(context, agentId),
      listProcedures(context, agentId),
      listWidgets(context, agentId),
      database(context).execute<{
        id: string
        kind: string
        name: string
        uri: string | null
        mimeType: string | null
        fileName: string | null
        contentText: string | null
        contentJson: JsonValue | null
        configJson: JsonValue
        revision: number
        activeRevision: number
        status: string
        contentHash: string | null
      }>(sql`
      SELECT id, kind, name, uri, mime_type AS "mimeType", file_name AS "fileName",
             content_text AS "contentText", content_json AS "contentJson",
             config_json AS "configJson", revision,
             active_revision AS "activeRevision", status,
             content_hash AS "contentHash"
      FROM build_knowledge_sources
      WHERE project_id = ${context.projectId} AND agent_id = ${agentId} AND status <> 'deleted'
      ORDER BY id
    `),
      database(context).execute<{
        id: string
        sourceId: string
        revision: number
        ordinal: number
        content: string
        metadataJson: JsonValue
      }>(sql`
      SELECT id, source_id AS "sourceId", revision, ordinal, content,
             metadata_json AS "metadataJson"
      FROM build_knowledge_chunks
      WHERE project_id = ${context.projectId} AND agent_id = ${agentId}
      ORDER BY source_id, revision, ordinal, id
    `),
    ])
  const chunksBySource = new Map<string, JsonValue[]>()
  const sourceRevisions = new Map(
    knowledgeSources.rows.map((source) => [source.id, source.revision])
  )
  for (const chunk of knowledgeChunks.rows) {
    // Snapshot the current source revision only. A source update can leave
    // the previous indexed chunks in place while a new index is pending; the
    // stale chunks must never leak into a simulation of the current draft.
    if (chunk.revision !== sourceRevisions.get(chunk.sourceId)) continue
    const chunks = chunksBySource.get(chunk.sourceId) ?? []
    chunks.push({
      id: chunk.id,
      revision: chunk.revision,
      ordinal: chunk.ordinal,
      content: chunk.content,
      metadata: chunk.metadataJson,
    })
    chunksBySource.set(chunk.sourceId, chunks)
  }
  const knowledge = knowledgeSources.rows.map((source) => ({
    ...source,
    chunks: chunksBySource.get(source.id) ?? [],
  }))
  return simulationConfigSnapshotSchema.parse({
    // Simulations exercise the current Build configuration, including a
    // draft that has not been deployed to customer channels yet.
    agentRevision: agent.currentRevision,
    // Keep secret handles out of the durable run snapshot. Public action
    // definitions are already redacted, but nested procedure/config/knowledge
    // metadata may still contain user supplied credential-shaped keys.
    config: redactSnapshotSecrets(agent.configuration),
    actions: actions.map(redactSnapshotSecrets),
    procedures: procedures.map(redactSnapshotSecrets),
    widgets: widgets.map(redactSnapshotSecrets),
    knowledge: knowledge.map(redactSnapshotSecrets),
    capturedAt: new Date().toISOString(),
  })
}

export type CreateSimulationDefinitionInput = {
  id?: string
  agentId: string
  definition: unknown
}

export type UpdateSimulationDefinitionInput = {
  definition: unknown
  expectedRevision: number
}

export type StartSimulationOptions = {
  models?: string[]
  repeats?: number
  requestedBy?: string | null
  snapshotLoader?: SimulationConfigSnapshotLoader
}

export async function listSimulationDefinitions(
  context: BuildContext,
  agentId: string,
  includeArchived = false
): Promise<SimulationDefinitionRecord[]> {
  await getAgent(context, agentId, { includeArchived: true })
  const predicates = [
    eq(buildTestDefinitions.projectId, context.projectId),
    eq(buildTestDefinitions.agentId, agentId),
  ]
  if (!includeArchived)
    predicates.push(eq(buildTestDefinitions.status, "active"))
  const rows = await database(context)
    .select()
    .from(buildTestDefinitions)
    .where(and(...predicates))
    .orderBy(asc(buildTestDefinitions.name))
  return rows.map(definitionModel)
}

export async function getSimulationDefinition(
  context: BuildContext,
  agentId: string,
  definitionId: string,
  includeArchived = false
): Promise<SimulationDefinitionRecord> {
  const predicates = [
    eq(buildTestDefinitions.projectId, context.projectId),
    eq(buildTestDefinitions.agentId, agentId),
    eq(buildTestDefinitions.id, definitionId),
  ]
  if (!includeArchived)
    predicates.push(eq(buildTestDefinitions.status, "active"))
  const rows = await database(context)
    .select()
    .from(buildTestDefinitions)
    .where(and(...predicates))
    .limit(1)
  if (!rows.length)
    throw new SimulationNotFoundError(
      `Simulation ${definitionId} was not found.`
    )
  return definitionModel(rows[0])
}

export async function createSimulationDefinition(
  context: BuildContext,
  input: CreateSimulationDefinitionInput
): Promise<SimulationDefinitionRecord> {
  await getAgent(context, input.agentId, { includeArchived: true })
  const definition = parseDefinition(input.definition)
  const createdAt = now()
  const definitionId = input.id ?? id("test")
  const row = {
    id: definitionId,
    projectId: context.projectId,
    agentId: input.agentId,
    revision: 1,
    name: definition.name,
    definitionJson: definition,
    status: "active" as const,
    createdAt,
    updatedAt: createdAt,
    createdBy: context.actorId ?? null,
  }
  try {
    await database(context).transaction(async (tx) => {
      await tx.insert(buildTestDefinitions).values(row)
      await tx.insert(buildTestDefinitionRevisions).values({
        id: id("testr"),
        projectId: context.projectId,
        definitionId,
        agentId: input.agentId,
        revision: 1,
        definitionJson: definition,
        createdAt,
        createdBy: context.actorId ?? null,
      })
    })
  } catch (error) {
    if (isUniqueViolation(error))
      throw new SimulationConflictError(
        "A simulation with this name or id already exists."
      )
    throw error
  }
  return definitionModel(row)
}

export async function updateSimulationDefinition(
  context: BuildContext,
  agentId: string,
  definitionId: string,
  input: UpdateSimulationDefinitionInput
): Promise<SimulationDefinitionRecord> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new SimulationValidationError(
      "expectedRevision must be a positive integer."
    )
  const definition = parseDefinition(input.definition)
  const updatedAt = now()
  const row = await database(context).transaction(async (tx) => {
    const updated = await tx
      .update(buildTestDefinitions)
      .set({
        name: definition.name,
        revision: input.expectedRevision + 1,
        definitionJson: definition,
        updatedAt,
      })
      .where(
        and(
          eq(buildTestDefinitions.projectId, context.projectId),
          eq(buildTestDefinitions.agentId, agentId),
          eq(buildTestDefinitions.id, definitionId),
          eq(buildTestDefinitions.status, "active"),
          eq(buildTestDefinitions.revision, input.expectedRevision)
        )
      )
      .returning()
    if (!updated.length)
      throw new SimulationConflictError(
        "Simulation changed, archived, or was not found; refresh before saving."
      )
    await tx.insert(buildTestDefinitionRevisions).values({
      id: id("testr"),
      projectId: context.projectId,
      definitionId,
      agentId,
      revision: input.expectedRevision + 1,
      definitionJson: definition,
      createdAt: updatedAt,
      createdBy: context.actorId ?? null,
    })
    return updated[0]
  })
  return definitionModel(row)
}

export async function archiveSimulationDefinition(
  context: BuildContext,
  agentId: string,
  definitionId: string,
  expectedRevision: number
) {
  const updated = await database(context)
    .update(buildTestDefinitions)
    .set({
      status: "archived",
      revision: expectedRevision + 1,
      updatedAt: now(),
    })
    .where(
      and(
        eq(buildTestDefinitions.projectId, context.projectId),
        eq(buildTestDefinitions.agentId, agentId),
        eq(buildTestDefinitions.id, definitionId),
        eq(buildTestDefinitions.status, "active"),
        eq(buildTestDefinitions.revision, expectedRevision)
      )
    )
    .returning()
  if (!updated.length)
    throw new SimulationConflictError(
      "Simulation changed, archived, or was not found; refresh before archiving."
    )
  return definitionModel(updated[0])
}

export async function listSimulationDefinitionRevisions(
  context: BuildContext,
  agentId: string,
  definitionId: string
) {
  await getSimulationDefinition(context, agentId, definitionId, true)
  const rows = await database(context)
    .select()
    .from(buildTestDefinitionRevisions)
    .where(
      and(
        eq(buildTestDefinitionRevisions.projectId, context.projectId),
        eq(buildTestDefinitionRevisions.agentId, agentId),
        eq(buildTestDefinitionRevisions.definitionId, definitionId)
      )
    )
    .orderBy(desc(buildTestDefinitionRevisions.revision))
  return rows.map((row) => ({
    id: row.id,
    definitionId: row.definitionId,
    revision: row.revision,
    definition: parseDefinition(row.definitionJson),
    createdAt: iso(row.createdAt)!,
    createdBy: row.createdBy,
  }))
}

export async function addSimulationToolMock(
  context: BuildContext,
  agentId: string,
  definitionId: string,
  value: unknown
) {
  await getSimulationDefinition(context, agentId, definitionId)
  let mock: ToolMock
  try {
    mock = toolMockSchema.parse(value)
  } catch (error) {
    throw new SimulationValidationError(
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error)
    )
  }
  const row = {
    id: id("mock"),
    projectId: context.projectId,
    definitionId,
    mockJson: mock,
    createdAt: now(),
    createdBy: context.actorId ?? null,
  }
  await database(context).insert(buildTestToolMocks).values(row)
  return { id: row.id, definitionId, mock, createdAt: iso(row.createdAt)! }
}

export async function listSimulationToolMocks(
  context: BuildContext,
  agentId: string,
  definitionId: string
) {
  await getSimulationDefinition(context, agentId, definitionId)
  const rows = await database(context)
    .select()
    .from(buildTestToolMocks)
    .where(
      and(
        eq(buildTestToolMocks.projectId, context.projectId),
        eq(buildTestToolMocks.definitionId, definitionId)
      )
    )
    .orderBy(asc(buildTestToolMocks.createdAt))
  return rows.map((row) => ({
    id: row.id,
    definitionId: row.definitionId,
    mock: toolMockSchema.parse(row.mockJson),
    createdAt: iso(row.createdAt)!,
  }))
}

async function loadMocks(
  context: BuildContext,
  definitionId: string
): Promise<ToolMock[]> {
  const rows = await database(context)
    .select()
    .from(buildTestToolMocks)
    .where(
      and(
        eq(buildTestToolMocks.projectId, context.projectId),
        eq(buildTestToolMocks.definitionId, definitionId)
      )
    )
    .orderBy(asc(buildTestToolMocks.createdAt))
  return rows.map((row) => toolMockSchema.parse(row.mockJson))
}

function matchesMock(
  mock: ToolMock,
  actionId: string,
  args: Record<string, JsonValue>
) {
  if (mock.matcher.actionId !== actionId) return false
  if (mock.matcher.match === "action") return true
  return canonicalJson(mock.matcher.arguments) === canonicalJson(args)
}

export type SimulationToolCall = {
  actionId: string
  arguments: Record<string, JsonValue>
  response?: JsonValue
  error?: string
  mocked: true
}

export type SimulationExecutorInput = {
  run: SimulationRunRecord
  definition: SimulationDefinitionRecord
  testCase: SimulationCaseRecord
  configSnapshot: SimulationConfigSnapshot
  toolMocks: readonly ToolMock[]
  callMockedTool: (
    actionId: string,
    arguments_: Record<string, JsonValue>,
    signal?: AbortSignal
  ) => Promise<SimulationToolCall>
  /** Keep the run lease alive while a hosted model is producing turns. */
  renewLease: () => Promise<void>
  /** Abort long model/tool work when the durable run is cancelled. */
  signal: AbortSignal
  /** Abort provider work when this worker loses its durable lease fence. */
  abort: () => void
  isCancelled: () => Promise<boolean>
  leaseSeconds: number
}

export type SimulationExecutorResult = {
  transcript: SimulationMessage[]
  observedActions: ObservedAction[]
  verdict: SimulationVerdict
  cancelled?: boolean
}

export type SimulationExecutor = (
  input: SimulationExecutorInput
) => Promise<SimulationExecutorResult>

function expectedActionFailure(
  expected: readonly ExpectedAction[],
  observed: readonly ObservedAction[]
) {
  const missing = expected
    .filter(
      (action) =>
        action.required &&
        !observed.some(
          (candidate) =>
            candidate.status === "succeeded" &&
            candidate.actionId === action.actionId &&
            (Object.keys(action.arguments).length === 0 ||
              canonicalJson(candidate.arguments) ===
                canonicalJson(action.arguments))
        )
    )
    .map((action) => action.actionId)
  return missing.length ? missing : null
}

export async function startSimulationRun(
  context: BuildContext,
  agentId: string,
  definitionId: string,
  options: StartSimulationOptions = {}
): Promise<SimulationRunRecord> {
  const definition = await getSimulationDefinition(
    context,
    agentId,
    definitionId
  )
  const models = (options.models ?? definition.models).map((model) =>
    model.trim()
  )
  const repeats = options.repeats ?? definition.repeats
  if (
    !models.length ||
    models.length > 20 ||
    models.some((model) => !model) ||
    new Set(models).size !== models.length
  )
    throw new SimulationValidationError(
      "At least one and at most 20 unique model variants are required."
    )
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
    throw new SimulationValidationError("repeats must be between 1 and 100.")
  const snapshot = await (options.snapshotLoader ?? captureSimulationConfig)(
    context,
    agentId
  )
  const runId = id("testrun")
  const createdAt = now()
  const cases = models.flatMap((model) =>
    Array.from({ length: repeats }, (_, repeatIndex) => ({
      id: id("testcase"),
      projectId: context.projectId,
      runId,
      ordinal: repeatIndex,
      repeatIndex,
      variantKey: `${model}:${repeatIndex + 1}`,
      model,
      status: "queued" as const,
      transcriptJson: [],
      observedActionsJson: [],
      verdictJson: null,
      error: null,
      startedAt: null,
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }))
  )
  await database(context).transaction(async (tx) => {
    await tx.insert(buildTestRuns).values({
      id: runId,
      projectId: context.projectId,
      definitionId,
      status: "queued",
      requestedCases: cases.length,
      completedCases: 0,
      passedCases: 0,
      failedCases: 0,
      noVerdictCases: 0,
      infraErrorCases: 0,
      configSnapshotJson: snapshot,
      createdAt,
      startedAt: null,
      completedAt: null,
      error: null,
      requestedBy: options.requestedBy ?? context.actorId ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    await tx.insert(buildTestCases).values(cases)
  })
  return getSimulationRun(context, runId)
}

export async function getSimulationRun(
  context: BuildContext,
  runId: string
): Promise<SimulationRunRecord> {
  const rows = await database(context)
    .select()
    .from(buildTestRuns)
    .where(
      and(
        eq(buildTestRuns.projectId, context.projectId),
        eq(buildTestRuns.id, runId)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new SimulationNotFoundError(`Simulation run ${runId} was not found.`)
  return runModel(rows[0])
}

export async function listSimulationRuns(
  context: BuildContext,
  definitionId?: string
) {
  const predicates = [eq(buildTestRuns.projectId, context.projectId)]
  if (definitionId)
    predicates.push(eq(buildTestRuns.definitionId, definitionId))
  const rows = await database(context)
    .select()
    .from(buildTestRuns)
    .where(and(...predicates))
    .orderBy(desc(buildTestRuns.createdAt))
  return rows.map(runModel)
}

export async function listSimulationCases(
  context: BuildContext,
  runId: string
) {
  await getSimulationRun(context, runId)
  const rows = await database(context)
    .select()
    .from(buildTestCases)
    .where(
      and(
        eq(buildTestCases.projectId, context.projectId),
        eq(buildTestCases.runId, runId)
      )
    )
    .orderBy(asc(buildTestCases.ordinal), asc(buildTestCases.variantKey))
  return rows.map(caseModel)
}

export async function claimSimulationRun(
  context: BuildContext,
  runId: string,
  leaseSeconds = 45
) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
    throw new SimulationValidationError(
      "leaseSeconds must be between 5 and 300."
    )
  const owner = randomUUID()
  const rows = await database(context).execute<{ id: string }>(sql`
    UPDATE build_test_runs
    SET status = 'running', started_at = COALESCE(started_at, now()), lease_owner = ${owner},
        lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
    WHERE project_id = ${context.projectId} AND id = ${runId}
      AND status IN ('queued','running')
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    RETURNING id
  `)
  if (!rows.rows.length)
    throw new SimulationLeaseError(
      "The run is cancelled, complete, or owned by another live worker."
    )
  return { runId, owner }
}

export type SimulationRunClaim = {
  runId: string
  owner: string
}

/**
 * Cross-project admission query for the long-lived Build worker. The worker
 * uses the returned project ids to create a project-bound BuildContext and
 * then calls runQueuedSimulationRuns; no request-scoped context is reused.
 */
export async function listSimulationProjectsWithPendingRuns(
  database: BuildContext["database"],
  limit = 100
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
    throw new SimulationValidationError("limit must be between 1 and 1000.")
  const rows = await database.execute<{ projectId: string }>(sql`
    SELECT project_id AS "projectId"
    FROM build_test_runs
    WHERE status IN ('queued', 'running')
      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
    GROUP BY project_id
    ORDER BY min(created_at) ASC, project_id ASC
    LIMIT ${limit}
  `)
  return rows.rows.map((row) => row.projectId)
}

/**
 * Claim the oldest queued or expired run for this project. The row lock and
 * SKIP LOCKED make this safe for several long-lived workers polling the same
 * database. A run remains durable when a worker disappears; the lease is the
 * recovery boundary and no request handler needs to remain alive.
 */
export async function claimNextSimulationRun(
  context: BuildContext,
  leaseSeconds = 45
): Promise<SimulationRunClaim | null> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
    throw new SimulationValidationError(
      "leaseSeconds must be between 5 and 300."
    )
  const owner = randomUUID()
  const claimed = await database(context).transaction(async (tx) => {
    const candidate = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM build_test_runs
      WHERE project_id = ${context.projectId}
        AND status IN ('queued', 'running')
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `)
    const runId = candidate.rows[0]?.id
    if (!runId) return null
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE build_test_runs
      SET status = 'running', started_at = COALESCE(started_at, now()),
          lease_owner = ${owner},
          lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
      WHERE project_id = ${context.projectId} AND id = ${runId}
        AND status IN ('queued', 'running')
      RETURNING id
    `)
    return updated.rows[0]?.id ? { runId, owner } : null
  })
  return claimed
}

export async function renewSimulationRunLease(
  context: BuildContext,
  runId: string,
  owner: string,
  leaseSeconds = 45
) {
  const rows = await database(context).execute<{ id: string }>(sql`
    UPDATE build_test_runs SET lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
    WHERE project_id = ${context.projectId} AND id = ${runId} AND status = 'running' AND lease_owner = ${owner} AND lease_expires_at > now()
    RETURNING id
  `)
  if (!rows.rows.length)
    throw new SimulationLeaseError("The run lease is no longer active.")
}

/**
 * Keep the individual case lease alive alongside its parent run lease. A
 * worker may spend longer than the initial lease in a provider request; the
 * case fence must move with the run fence or a recovery worker could claim it
 * while the original model call is still in flight.
 */
export async function renewSimulationCaseLease(
  context: BuildContext,
  runId: string,
  caseId: string,
  owner: string,
  leaseSeconds = 45
) {
  const rows = await database(context).execute<{ id: string }>(sql`
    UPDATE build_test_cases SET lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
    WHERE project_id = ${context.projectId} AND run_id = ${runId} AND id = ${caseId}
      AND status = 'running' AND lease_owner = ${owner} AND lease_expires_at > now()
    RETURNING id
  `)
  if (!rows.rows.length)
    throw new SimulationLeaseError(
      "The simulation case lease is no longer active."
    )
}

export async function recoverSimulationRun(
  context: BuildContext,
  runId: string,
  leaseSeconds = 45
) {
  const run = await getSimulationRun(context, runId)
  if (run.status === "completed" || run.status === "cancelled") return null
  await database(context).execute(sql`
    UPDATE build_test_cases SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
    WHERE project_id = ${context.projectId} AND run_id = ${runId} AND status = 'running' AND lease_expires_at <= now()
  `)
  return claimSimulationRun(context, runId, leaseSeconds)
}

async function recoverExpiredSimulationCases(
  context: BuildContext,
  runId: string
) {
  await database(context).execute(sql`
    UPDATE build_test_cases
    SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
    WHERE project_id = ${context.projectId} AND run_id = ${runId}
      AND status = 'running' AND lease_expires_at <= now()
  `)
}

async function isSimulationRunCancelled(
  context: BuildContext,
  runId: string
): Promise<boolean> {
  const rows = await database(context).execute<{ status: string }>(sql`
    SELECT status
    FROM build_test_runs
    WHERE project_id = ${context.projectId} AND id = ${runId}
    LIMIT 1
  `)
  return rows.rows[0]?.status === "cancelled"
}

async function cancelSimulationCase(
  context: BuildContext,
  runId: string,
  caseId: string,
  owner: string
) {
  await database(context)
    .update(buildTestCases)
    .set({
      status: "cancelled",
      completedAt: now(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(buildTestCases.projectId, context.projectId),
        eq(buildTestCases.runId, runId),
        eq(buildTestCases.id, caseId),
        eq(buildTestCases.leaseOwner, owner)
      )
    )
}

export async function cancelSimulationRun(
  context: BuildContext,
  runId: string
) {
  const updated = await database(context).execute<{ id: string }>(sql`
    UPDATE build_test_runs SET status = 'cancelled', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
    WHERE project_id = ${context.projectId} AND id = ${runId} AND status IN ('queued','running')
    RETURNING id
  `)
  if (!updated.rows.length)
    throw new SimulationConflictError(
      "The run is already terminal or was not found."
    )
  await database(context).execute(sql`
    UPDATE build_test_cases SET status = 'cancelled', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
    WHERE project_id = ${context.projectId} AND run_id = ${runId} AND status IN ('queued','running')
  `)
  return getSimulationRun(context, runId)
}

async function claimSimulationCase(
  context: BuildContext,
  runId: string,
  caseId: string,
  owner: string,
  leaseSeconds = 45
) {
  const rows = await database(context).execute<{ id: string }>(sql`
    UPDATE build_test_cases SET status = 'running', started_at = COALESCE(started_at, now()), lease_owner = ${owner},
      lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
    WHERE project_id = ${context.projectId} AND run_id = ${runId} AND id = ${caseId}
      AND status IN ('queued','running') AND (lease_expires_at IS NULL OR lease_expires_at <= now() OR lease_owner = ${owner})
    RETURNING id
  `)
  if (!rows.rows.length)
    throw new SimulationLeaseError(
      "The simulation case is already owned or terminal."
    )
}

async function finalizeRun(context: BuildContext, runId: string) {
  const rows = await database(context)
    .select({
      status: buildTestCases.status,
      verdict: buildTestCases.verdictJson,
    })
    .from(buildTestCases)
    .where(
      and(
        eq(buildTestCases.projectId, context.projectId),
        eq(buildTestCases.runId, runId)
      )
    )
  const terminal = rows.every((row) =>
    ["completed", "failed", "cancelled"].includes(row.status)
  )
  if (!terminal) return getSimulationRun(context, runId)
  const completed = rows.filter(
    (row) => row.status === "completed" || row.status === "failed"
  )
  const verdicts = completed
    .map((row) => simulationVerdictSchema.safeParse(row.verdict))
    .map((result) => (result.success ? result.data : null))
  const values = {
    completedCases: completed.length,
    passedCases: verdicts.filter((verdict) => verdict?.status === "passed")
      .length,
    failedCases: verdicts.filter((verdict) => verdict?.status === "failed")
      .length,
    noVerdictCases: verdicts.filter(
      (verdict) => verdict?.status === "no_verdict"
    ).length,
    infraErrorCases: verdicts.filter(
      (verdict) => verdict?.status === "infra_error"
    ).length,
    status: rows.some((row) => row.status === "cancelled")
      ? ("cancelled" as const)
      : ("completed" as const),
    completedAt: now(),
    leaseOwner: null,
    leaseExpiresAt: null,
  }
  await database(context)
    .update(buildTestRuns)
    .set(values)
    .where(
      and(
        eq(buildTestRuns.projectId, context.projectId),
        eq(buildTestRuns.id, runId),
        inArray(buildTestRuns.status, ["running", "queued"])
      )
    )
  return getSimulationRun(context, runId)
}

export async function executeSimulationCase(
  context: BuildContext,
  runId: string,
  caseId: string,
  owner: string,
  executor: SimulationExecutor,
  leaseSeconds = 45
): Promise<SimulationCaseRecord> {
  await renewSimulationRunLease(context, runId, owner, leaseSeconds)
  await claimSimulationCase(context, runId, caseId, owner, leaseSeconds)
  const [run, cases] = await Promise.all([
    getSimulationRun(context, runId),
    listSimulationCases(context, runId),
  ])
  const testCase = cases.find((candidate) => candidate.id === caseId)
  if (!testCase)
    throw new SimulationNotFoundError(
      `Simulation case ${caseId} was not found.`
    )
  const definitionRows = await database(context)
    .select()
    .from(buildTestDefinitions)
    .where(
      and(
        eq(buildTestDefinitions.projectId, context.projectId),
        eq(buildTestDefinitions.id, run.definitionId)
      )
    )
    .limit(1)
  if (!definitionRows.length)
    throw new SimulationNotFoundError(
      `Simulation definition ${run.definitionId} was not found.`
    )
  const definition = definitionModel(definitionRows[0])
  const toolMocks = await loadMocks(context, definition.id)
  const callMockedTool = async (
    actionId: string,
    arguments_: Record<string, JsonValue>,
    signal?: AbortSignal
  ): Promise<SimulationToolCall> => {
    if (signal?.aborted)
      throw new SimulationLeaseError("The simulation was cancelled.")
    const mock = toolMocks.find((candidate) =>
      matchesMock(candidate, actionId, arguments_)
    )
    if (!mock)
      throw new SimulationValidationError(
        `Action ${actionId} has no test mock; live actions are disabled in simulations.`
      )
    if (mock.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          reject(new SimulationLeaseError("The simulation was cancelled."))
        }
        const finish = () => {
          signal?.removeEventListener("abort", abort)
          resolve()
        }
        const timer = setTimeout(finish, mock.latencyMs)
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      })
    }
    if (signal?.aborted)
      throw new SimulationLeaseError("The simulation was cancelled.")
    return {
      actionId,
      arguments: arguments_,
      ...(mock.response !== undefined ? { response: mock.response } : {}),
      ...(mock.error ? { error: mock.error } : {}),
      mocked: true,
    }
  }
  const abortController = new AbortController()
  const cancellationPoll = setInterval(() => {
    void isSimulationRunCancelled(context, runId)
      .then((cancelled) => {
        if (cancelled) abortController.abort()
      })
      .catch(() => undefined)
  }, 1_000)
  let result: SimulationExecutorResult | null = null
  let caseCancelled = false
  try {
    result = await executor({
      run,
      definition,
      testCase,
      configSnapshot: run.configSnapshot,
      toolMocks,
      callMockedTool,
      renewLease: async () => {
        await renewSimulationRunLease(context, runId, owner, leaseSeconds)
        await renewSimulationCaseLease(
          context,
          runId,
          caseId,
          owner,
          leaseSeconds
        )
      },
      signal: abortController.signal,
      abort: () => abortController.abort(),
      isCancelled: () => isSimulationRunCancelled(context, runId),
      leaseSeconds,
    })
    caseCancelled =
      result.cancelled === true ||
      (await isSimulationRunCancelled(context, runId).catch(() => false))
    if (caseCancelled) {
      await cancelSimulationCase(context, runId, caseId, owner)
    } else {
      const parsedTranscript = z
        .array(simulationMessageSchema)
        .safeParse(result.transcript)
      const parsedActions = z
        .array(observedActionSchema)
        .safeParse(result.observedActions)
      const parsedVerdict = simulationVerdictSchema.safeParse(result.verdict)
      if (
        !parsedTranscript.success ||
        !parsedActions.success ||
        !parsedVerdict.success
      )
        throw new SimulationValidationError(
          "Simulation executor returned an invalid transcript, action list, or verdict."
        )
      const missing = expectedActionFailure(
        definition.expectedActions,
        parsedActions.data
      )
      const verdict =
        missing && parsedVerdict.data.status === "passed"
          ? {
              ...parsedVerdict.data,
              status: "failed" as const,
              reason: `Required actions were not observed: ${missing.join(", ")}`,
            }
          : parsedVerdict.data
      const status =
        verdict.status === "infra_error"
          ? ("failed" as const)
          : ("completed" as const)
      await database(context)
        .update(buildTestCases)
        .set({
          status,
          transcriptJson: parsedTranscript.data,
          observedActionsJson: parsedActions.data,
          verdictJson: verdict,
          error: verdict.status === "infra_error" ? verdict.reason : null,
          completedAt: now(),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(buildTestCases.projectId, context.projectId),
            eq(buildTestCases.runId, runId),
            eq(buildTestCases.id, caseId),
            eq(buildTestCases.leaseOwner, owner),
            gt(buildTestCases.leaseExpiresAt, now())
          )
        )
    }
  } catch (error) {
    caseCancelled = await isSimulationRunCancelled(context, runId).catch(
      () => false
    )
    if (caseCancelled) await cancelSimulationCase(context, runId, caseId, owner)
    else {
      const reason = error instanceof Error ? error.message : String(error)
      const verdict: SimulationVerdict = {
        status: "infra_error",
        reason,
        criteria: [],
        score: null,
      }
      await database(context)
        .update(buildTestCases)
        .set({
          status: "failed",
          verdictJson: verdict,
          error: reason,
          completedAt: now(),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(buildTestCases.projectId, context.projectId),
            eq(buildTestCases.runId, runId),
            eq(buildTestCases.id, caseId),
            eq(buildTestCases.leaseOwner, owner),
            gt(buildTestCases.leaseExpiresAt, now())
          )
        )
    }
  } finally {
    clearInterval(cancellationPoll)
  }
  await finalizeRun(context, runId)
  const rows = await database(context)
    .select()
    .from(buildTestCases)
    .where(
      and(
        eq(buildTestCases.projectId, context.projectId),
        eq(buildTestCases.id, caseId)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new SimulationNotFoundError(
      `Simulation case ${caseId} was not found.`
    )
  return caseModel(rows[0])
}

export async function executeSimulationRun(
  context: BuildContext,
  runId: string,
  executor: SimulationExecutor
) {
  const claim = await claimSimulationRun(context, runId)
  return executeClaimedSimulationRun(context, claim, executor)
}

/** Execute a run that has already been claimed by a durable worker. */
export async function executeClaimedSimulationRun(
  context: BuildContext,
  claim: SimulationRunClaim,
  executor: SimulationExecutor,
  leaseSeconds = 45
) {
  await recoverExpiredSimulationCases(context, claim.runId)
  const cases = await listSimulationCases(context, claim.runId)
  for (const testCase of cases) {
    const current = await getSimulationRun(context, claim.runId)
    if (current.status === "cancelled") break
    // A live case lease belongs to another worker. Expired running cases were
    // reset above; leave the live one alone so two workers never execute it.
    if (
      ["running", "completed", "failed", "cancelled"].includes(testCase.status)
    )
      continue
    await executeSimulationCase(
      context,
      claim.runId,
      testCase.id,
      claim.owner,
      executor,
      leaseSeconds
    )
  }
  await finalizeRun(context, claim.runId)
  return getSimulationRun(context, claim.runId)
}

export type RunQueuedSimulationsOptions = {
  maxRuns?: number
  leaseSeconds?: number
}

/**
 * Worker-facing pump. It claims persisted runs until the bounded batch is
 * drained; callers can invoke it from a cron, queue consumer, or the Build
 * worker process without keeping an HTTP request open.
 */
export async function runQueuedSimulationRuns(
  context: BuildContext,
  executor: SimulationExecutor,
  options: RunQueuedSimulationsOptions = {}
) {
  const maxRuns = options.maxRuns ?? 1
  const leaseSeconds = options.leaseSeconds ?? 45
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100)
    throw new SimulationValidationError("maxRuns must be between 1 and 100.")
  const completed: SimulationRunRecord[] = []
  for (let index = 0; index < maxRuns; index += 1) {
    const claim = await claimNextSimulationRun(context, leaseSeconds)
    if (!claim) break
    completed.push(
      await executeClaimedSimulationRun(context, claim, executor, leaseSeconds)
    )
  }
  return completed
}

function isUniqueViolation(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  )
}
