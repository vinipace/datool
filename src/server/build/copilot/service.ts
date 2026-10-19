import { randomUUID } from "node:crypto"

import { and, asc, desc, eq } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"

import {
  agentConfigurationSchema,
  actionDefinitionSchema,
  procedureDefinitionSchema,
  widgetDefinitionSchema,
} from "@/src/lib/build/contracts"
import {
  copilotProposalInputSchema,
  copilotProposalStatusSchema,
  type CopilotGenerator,
  type CopilotProposalInput,
  type CopilotProposalRecord,
  type CopilotTargetKind,
} from "@/src/lib/build/testing"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import type { BuildContext } from "../context"
import { getAgent, updateAgent } from "../agents"
import { GATEWAY_PROVIDER, OPENAI_PROVIDER } from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import {
  getAction,
  getProcedure,
  getWidget,
  saveAction,
  saveProcedure,
  saveWidget,
} from "../definitions"
import {
  buildCopilotAudit,
  buildCopilotProposals,
  type BuildTestingSchema,
} from "../testing/schema"

type CopilotDatabase = NodePgDatabase<BuildTestingSchema>

function database(context: BuildContext): CopilotDatabase {
  return context.database as unknown as CopilotDatabase
}

function now() {
  return new Date()
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

export class CopilotNotFoundError extends Error {
  readonly code = "NOT_FOUND"
}

export class CopilotConflictError extends Error {
  readonly code = "CONFLICT"
}

export class CopilotValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
}

function iso(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isSecretKey(key: string) {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLocaleLowerCase()
  return /(?:^|[_-])(api[_-]?key|authorization|credential|password|secret|token|private[_-]?key|signing[_-]?key)$/.test(
    normalized
  )
}

function redactSecrets(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== "object") return value as JsonValue
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (isSecretKey(key)) return [key, "__REDACTED__"]
      return [key, redactSecrets(child)]
    })
  ) as JsonValue
}

function restoreRedacted(next: unknown, current: unknown): JsonValue {
  if (next === "__REDACTED__") return asJson(current)
  if (Array.isArray(next))
    return next.map((value, index) =>
      restoreRedacted(
        value,
        Array.isArray(current) ? current[index] : undefined
      )
    )
  if (!next || typeof next !== "object") return next as JsonValue
  const currentRecord =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      restoreRedacted(value, currentRecord[key]),
    ])
  ) as JsonValue
}

function diffValue(before: unknown, after: unknown, path = ""): JsonValue {
  if (JSON.stringify(before) === JSON.stringify(after))
    return { path, kind: "unchanged" }
  if (
    Array.isArray(before) ||
    Array.isArray(after) ||
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object"
  ) {
    return {
      path,
      kind: "changed",
      before: redactSecrets(before),
      after: redactSecrets(after),
    }
  }
  const keys = new Set([
    ...Object.keys(before as object),
    ...Object.keys(after as object),
  ])
  const children = [...keys]
    .sort()
    .map((key) =>
      diffValue(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key
      )
    )
    .filter((child) => (child as { kind?: string }).kind !== "unchanged")
  return { path, kind: "object", changes: children }
}

function proposalModel(
  row: typeof buildCopilotProposals.$inferSelect
): CopilotProposalRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    targetKind: row.targetKind as CopilotTargetKind,
    targetId: row.targetId,
    status: copilotProposalStatusSchema.parse(row.status),
    baseRevision: row.baseRevision,
    request: row.request,
    sourceSnapshot: asJson(row.sourceSnapshotJson),
    proposedValue: asJson(row.proposedValueJson),
    diff: asJson(row.diffJson),
    createdAt: iso(row.createdAt)!,
    createdBy: row.createdBy,
    approvedAt: iso(row.approvedAt),
    approvedBy: row.approvedBy,
    appliedAt: iso(row.appliedAt),
  }
}

async function currentTarget(
  context: BuildContext,
  input: CopilotProposalInput
) {
  const agent = await getAgent(context, input.agentId, {
    includeArchived: true,
  })
  if (input.targetKind === "instructions") {
    return { revision: agent.currentRevision, value: agent.configuration }
  }
  if (!input.targetId)
    throw new CopilotValidationError(
      `${input.targetKind} proposals require targetId.`
    )
  if (input.targetKind === "action") {
    const value = await getAction(context, input.agentId, input.targetId)
    return { revision: value.revision, value: value.definition }
  }
  if (input.targetKind === "procedure") {
    const value = await getProcedure(context, input.agentId, input.targetId)
    return { revision: value.revision, value: value.definition }
  }
  const value = await getWidget(context, input.agentId, input.targetId)
  return { revision: value.revision, value: value.definition }
}

export type CreateCopilotProposalOptions = {
  generator: CopilotGenerator
}

/**
 * Uses the agent's configured project or direct OpenAI model to draft a JSON
 * value. The proposal remains inert until a human approves it, and this
 * function never mutates Build state itself.
 */
export function defaultCopilotGenerator(
  context: BuildContext
): CopilotGenerator {
  return async ({
    agentId,
    request,
    targetKind,
    targetId,
    sourceSnapshot,
    model,
  }) => {
    const agent = await getAgent(context, agentId, {
      includeArchived: true,
    })
    const selectedModel =
      model?.trim() || (agent?.configuration.model ?? "").trim()
    if (!selectedModel)
      throw new CopilotValidationError(
        "Configure an agent model before using the management copilot."
      )
    const selectedProvider =
      agent.configuration.provider === "openai"
        ? OPENAI_PROVIDER
        : GATEWAY_PROVIDER
    const apiKey = await getProjectProviderKey(
      context.projectId,
      selectedProvider,
      context.database
    )
    const modelId = selectedModel.startsWith(`${selectedProvider}/`)
      ? selectedModel.slice(`${selectedProvider}/`.length)
      : selectedModel
    const languageModel =
      selectedProvider === OPENAI_PROVIDER
        ? createOpenAI({ apiKey }).chat(modelId)
        : createGateway({ apiKey }).languageModel(modelId)
    const result = await generateText({
      model: languageModel,
      temperature: 0.1,
      maxOutputTokens: 8_000,
      system: [
        "You are Datool's management copilot.",
        "Return only a JSON object with one key, proposedValue.",
        "The proposed value must be a complete replacement for the target and must preserve valid fields from the source snapshot.",
        "Never include credentials, tokens, secrets, or executable code outside the target's declared configuration.",
      ].join("\n"),
      prompt: JSON.stringify({ request, targetKind, targetId, sourceSnapshot }),
      maxRetries: 0,
    })
    const text = result.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new CopilotValidationError(
        "The copilot model returned invalid JSON; no proposal was saved."
      )
    }
    if (!parsed || typeof parsed !== "object" || !("proposedValue" in parsed))
      throw new CopilotValidationError(
        "The copilot model did not return a proposedValue."
      )
    return {
      proposedValue: (parsed as { proposedValue: JsonValue }).proposedValue,
      summary:
        typeof (parsed as { summary?: unknown }).summary === "string"
          ? (parsed as unknown as { summary: string }).summary
          : undefined,
    }
  }
}

export async function createCopilotProposal(
  context: BuildContext,
  input: unknown,
  options: CreateCopilotProposalOptions
): Promise<CopilotProposalRecord> {
  const parsed = copilotProposalInputSchema.safeParse(input)
  if (!parsed.success)
    throw new CopilotValidationError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    )
  const target = await currentTarget(context, parsed.data)
  const sourceSnapshot = redactSecrets({
    revision: target.revision,
    value: target.value,
  })
  const generated = await options.generator({
    ...parsed.data,
    sourceSnapshot,
  })
  // Keep model output safe to persist and compare only the target value. The
  // revision lives in sourceSnapshot metadata and is not part of the target.
  const proposedValue = redactSecrets(generated.proposedValue)
  const sourceValue =
    sourceSnapshot &&
    typeof sourceSnapshot === "object" &&
    !Array.isArray(sourceSnapshot) &&
    "value" in sourceSnapshot
      ? (sourceSnapshot as { value: JsonValue }).value
      : sourceSnapshot
  const diff = diffValue(sourceValue, proposedValue)
  const createdAt = now()
  const row = {
    id: id("proposal"),
    projectId: context.projectId,
    agentId: parsed.data.agentId,
    targetKind: parsed.data.targetKind,
    targetId: parsed.data.targetId,
    status: "proposed" as const,
    baseRevision: target.revision,
    request: parsed.data.request,
    sourceSnapshotJson: sourceSnapshot,
    proposedValueJson: proposedValue,
    diffJson: diff,
    createdAt,
    createdBy: context.actorId ?? null,
    approvedAt: null,
    approvedBy: null,
    appliedAt: null,
  }
  await database(context).transaction(async (tx) => {
    await tx.insert(buildCopilotProposals).values(row)
    await tx.insert(buildCopilotAudit).values({
      id: id("copilot_audit"),
      projectId: context.projectId,
      proposalId: row.id,
      event: "created",
      actorId: context.actorId ?? null,
      payloadJson: {
        request: row.request,
        targetKind: row.targetKind,
        targetId: row.targetId,
        summary: generated.summary ?? null,
      },
      createdAt,
    })
  })
  return proposalModel(row)
}

export async function listCopilotProposals(
  context: BuildContext,
  agentId: string,
  status?: CopilotProposalRecord["status"]
) {
  const predicates = [
    eq(buildCopilotProposals.projectId, context.projectId),
    eq(buildCopilotProposals.agentId, agentId),
  ]
  if (status) predicates.push(eq(buildCopilotProposals.status, status))
  const rows = await database(context)
    .select()
    .from(buildCopilotProposals)
    .where(and(...predicates))
    .orderBy(desc(buildCopilotProposals.createdAt))
  return rows.map(proposalModel)
}

export async function getCopilotProposal(
  context: BuildContext,
  proposalId: string
) {
  const rows = await database(context)
    .select()
    .from(buildCopilotProposals)
    .where(
      and(
        eq(buildCopilotProposals.projectId, context.projectId),
        eq(buildCopilotProposals.id, proposalId)
      )
    )
    .limit(1)
  if (!rows.length)
    throw new CopilotNotFoundError(
      `Copilot proposal ${proposalId} was not found.`
    )
  return proposalModel(rows[0])
}

async function transitionProposal(
  context: BuildContext,
  proposalId: string,
  from: CopilotProposalRecord["status"],
  to: CopilotProposalRecord["status"],
  event: string
) {
  const timestamp = now()
  const values =
    to === "approved"
      ? {
          status: to,
          approvedAt: timestamp,
          approvedBy: context.actorId ?? null,
        }
      : { status: to }
  const rows = await database(context).transaction(async (tx) => {
    const updated = await tx
      .update(buildCopilotProposals)
      .set(values)
      .where(
        and(
          eq(buildCopilotProposals.projectId, context.projectId),
          eq(buildCopilotProposals.id, proposalId),
          eq(buildCopilotProposals.status, from)
        )
      )
      .returning()
    if (!updated.length)
      throw new CopilotConflictError(
        `Proposal must be ${from} before it can become ${to}.`
      )
    await tx.insert(buildCopilotAudit).values({
      id: id("copilot_audit"),
      projectId: context.projectId,
      proposalId,
      event,
      actorId: context.actorId ?? null,
      payloadJson: { from, to },
      createdAt: timestamp,
    })
    return updated
  })
  return proposalModel(rows[0])
}

export function approveCopilotProposal(
  context: BuildContext,
  proposalId: string
) {
  return transitionProposal(
    context,
    proposalId,
    "proposed",
    "approved",
    "approved"
  )
}

export function rejectCopilotProposal(
  context: BuildContext,
  proposalId: string
) {
  return transitionProposal(
    context,
    proposalId,
    "proposed",
    "rejected",
    "rejected"
  )
}

export async function applyCopilotProposal(
  context: BuildContext,
  proposalId: string,
  expectedRevision?: number
) {
  const proposal = await getCopilotProposal(context, proposalId)
  if (proposal.status !== "approved")
    throw new CopilotConflictError("Only an approved proposal can be applied.")
  const targetInput: CopilotProposalInput = {
    agentId: proposal.agentId,
    targetKind: proposal.targetKind,
    targetId: proposal.targetId,
    request: proposal.request,
  }
  const target = await currentTarget(context, targetInput)
  if (expectedRevision !== undefined && target.revision !== expectedRevision) {
    throw new CopilotConflictError(
      "The target revision changed; refresh the proposal before applying it."
    )
  }
  if (target.revision !== proposal.baseRevision) {
    await transitionProposal(
      context,
      proposalId,
      "approved",
      "expired",
      "expired"
    )
    throw new CopilotConflictError(
      "The target changed after this proposal was generated; create a fresh proposal."
    )
  }
  const nextValue = restoreRedacted(proposal.proposedValue, target.value)
  if (proposal.targetKind === "instructions") {
    const config = agentConfigurationSchema.safeParse(nextValue)
    if (!config.success)
      throw new CopilotValidationError(
        config.error.issues.map((issue) => issue.message).join("; ")
      )
    await updateAgent(context, proposal.agentId, {
      expectedRevision: proposal.baseRevision,
      configuration: config.data,
      apply: true,
    })
  } else if (proposal.targetKind === "action") {
    const value = actionDefinitionSchema.safeParse(nextValue)
    if (!value.success || !proposal.targetId)
      throw new CopilotValidationError(
        value.success
          ? "Action targetId is required."
          : value.error.issues.map((issue) => issue.message).join("; ")
      )
    await saveAction(context, proposal.agentId, {
      id: proposal.targetId,
      definition: value.data,
      expectedRevision: proposal.baseRevision,
    })
  } else if (proposal.targetKind === "procedure") {
    const value = procedureDefinitionSchema.safeParse(nextValue)
    if (!value.success || !proposal.targetId)
      throw new CopilotValidationError(
        value.success
          ? "Procedure targetId is required."
          : value.error.issues.map((issue) => issue.message).join("; ")
      )
    await saveProcedure(context, proposal.agentId, {
      id: proposal.targetId,
      definition: value.data,
      expectedRevision: proposal.baseRevision,
    })
  } else {
    const value = widgetDefinitionSchema.safeParse(nextValue)
    if (!value.success || !proposal.targetId)
      throw new CopilotValidationError(
        value.success
          ? "Widget targetId is required."
          : value.error.issues.map((issue) => issue.message).join("; ")
      )
    await saveWidget(context, proposal.agentId, {
      id: proposal.targetId,
      definition: value.data,
      expectedRevision: proposal.baseRevision,
    })
  }
  const appliedAt = now()
  const rows = await database(context)
    .update(buildCopilotProposals)
    .set({ status: "applied", appliedAt })
    .where(
      and(
        eq(buildCopilotProposals.projectId, context.projectId),
        eq(buildCopilotProposals.id, proposalId),
        eq(buildCopilotProposals.status, "approved")
      )
    )
    .returning()
  if (!rows.length)
    throw new CopilotConflictError(
      "Proposal changed while applying; refresh before retrying."
    )
  await database(context)
    .insert(buildCopilotAudit)
    .values({
      id: id("copilot_audit"),
      projectId: context.projectId,
      proposalId,
      event: "applied",
      actorId: context.actorId ?? null,
      payloadJson: {
        targetKind: proposal.targetKind,
        targetId: proposal.targetId,
        revision: proposal.baseRevision,
      },
      createdAt: appliedAt,
    })
  return proposalModel(rows[0])
}

export async function listCopilotAudit(
  context: BuildContext,
  proposalId: string
) {
  await getCopilotProposal(context, proposalId)
  const rows = await database(context)
    .select()
    .from(buildCopilotAudit)
    .where(
      and(
        eq(buildCopilotAudit.projectId, context.projectId),
        eq(buildCopilotAudit.proposalId, proposalId)
      )
    )
    .orderBy(asc(buildCopilotAudit.createdAt))
  return rows.map((row) => ({
    id: row.id,
    proposalId: row.proposalId,
    event: row.event,
    actorId: row.actorId,
    payload: asJson(row.payloadJson),
    createdAt: iso(row.createdAt)!,
  }))
}
