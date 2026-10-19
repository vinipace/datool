import { z } from "zod"

import type { JsonValue } from "@/src/lib/tracer/contracts"

export const simulationChannelSchema = z.enum(["web", "telegram", "api"])
export type SimulationChannel = z.infer<typeof simulationChannelSchema>

export const simulationPersonaSchema = z.object({
  name: z.string().max(160).default("Customer"),
  traits: z.array(z.string().min(1).max(500)).max(50).default([]),
  goals: z.array(z.string().min(1).max(500)).max(50).default([]),
  context: z.string().max(16_000).default(""),
})
export type SimulationPersona = z.infer<typeof simulationPersonaSchema>

export const expectedActionSchema = z.object({
  actionId: z.string().min(1).max(160),
  arguments: z.record(z.string(), z.json()).default({}),
  required: z.boolean().default(true),
})
export type ExpectedAction = z.infer<typeof expectedActionSchema>

export const simulationDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4_000).default(""),
  channel: simulationChannelSchema.default("telegram"),
  persona: simulationPersonaSchema.default({
    name: "Customer",
    traits: [],
    goals: [],
    context: "",
  }),
  scenario: z.string().min(1).max(16_000),
  initialMessage: z.string().min(1).max(8_000),
  successCriteria: z.array(z.string().min(1).max(2_000)).min(1).max(50),
  expectedActions: z.array(expectedActionSchema).max(100).default([]),
  maxTurns: z.number().int().min(1).max(200).default(20),
  repeats: z.number().int().min(1).max(100).default(1),
  models: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(20)
    .default(["default"]),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
export type SimulationDefinition = z.infer<typeof simulationDefinitionSchema>

export const simulationMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "event"]),
  content: z.string().max(64_000),
  turn: z.number().int().min(0),
  createdAt: z.string().datetime().optional(),
  metadata: z.record(z.string().max(120), z.json()).default({}),
})
export type SimulationMessage = z.infer<typeof simulationMessageSchema>

export const observedActionSchema = z.object({
  actionId: z.string().min(1).max(160),
  arguments: z.record(z.string(), z.json()).default({}),
  status: z.enum(["called", "succeeded", "failed", "blocked"]),
  result: z.json().optional(),
})
export type ObservedAction = z.infer<typeof observedActionSchema>

export const simulationVerdictSchema = z.object({
  status: z.enum(["passed", "failed", "no_verdict", "infra_error"]),
  reason: z.string().max(8_000).default(""),
  criteria: z
    .array(
      z.object({
        criterion: z.string().max(2_000),
        passed: z.boolean().nullable(),
        reason: z.string().max(4_000).default(""),
      })
    )
    .max(50)
    .default([]),
  score: z.number().min(0).max(1).nullable().default(null),
})
export type SimulationVerdict = z.infer<typeof simulationVerdictSchema>

/** Stable result labels consumed by Build tables and channel test UIs. */
export const simulationResultStatusSchema = z.enum([
  "pass",
  "fail",
  "error",
  "inconclusive",
])
export type SimulationResultStatus = z.infer<
  typeof simulationResultStatusSchema
>

export function simulationResultStatus(
  verdict: Pick<SimulationVerdict, "status"> | null | undefined
): SimulationResultStatus {
  if (!verdict || verdict.status === "no_verdict") return "inconclusive"
  if (verdict.status === "infra_error") return "error"
  return verdict.status === "passed" ? "pass" : "fail"
}

export const toolMockMatcherSchema = z.object({
  actionId: z.string().min(1).max(160),
  arguments: z.record(z.string(), z.json()).default({}),
  match: z.enum(["exact", "action"]).default("action"),
})
export type ToolMockMatcher = z.infer<typeof toolMockMatcherSchema>

export const toolMockSchema = z
  .object({
    matcher: toolMockMatcherSchema,
    response: z.json().optional(),
    error: z.string().max(4_000).optional(),
    latencyMs: z.number().int().min(0).max(30_000).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.response !== undefined && value.error !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A tool mock must provide a response or an error, not both.",
        path: ["response"],
      })
  })
export type ToolMock = z.infer<typeof toolMockSchema>

export const simulationConfigSnapshotSchema = z.object({
  agentRevision: z.number().int().positive(),
  config: z.json(),
  actions: z.array(z.json()).default([]),
  procedures: z.array(z.json()).default([]),
  widgets: z.array(z.json()).default([]),
  knowledge: z.array(z.json()).default([]),
  capturedAt: z.string().datetime(),
})
export type SimulationConfigSnapshot = z.infer<
  typeof simulationConfigSnapshotSchema
>

export type SimulationDefinitionRecord = SimulationDefinition & {
  id: string
  projectId: string
  agentId: string
  revision: number
  status: "active" | "archived"
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export type SimulationCaseStatus =
  "queued" | "running" | "completed" | "cancelled" | "failed"
export type SimulationRunStatus =
  "queued" | "running" | "completed" | "cancelled" | "failed"

export type SimulationRunRecord = {
  id: string
  projectId: string
  definitionId: string
  status: SimulationRunStatus
  requestedCases: number
  completedCases: number
  passedCases: number
  failedCases: number
  noVerdictCases: number
  infraErrorCases: number
  configSnapshot: SimulationConfigSnapshot
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  requestedBy: string | null
}

export type SimulationCaseRecord = {
  id: string
  projectId: string
  runId: string
  ordinal: number
  repeatIndex: number
  variantKey: string
  model: string
  status: SimulationCaseStatus
  transcript: SimulationMessage[]
  observedActions: ObservedAction[]
  verdict: SimulationVerdict | null
  error: string | null
  startedAt: string | null
  completedAt: string | null
}

export const copilotTargetKindSchema = z.enum([
  "instructions",
  "procedure",
  "widget",
  "action",
])
export type CopilotTargetKind = z.infer<typeof copilotTargetKindSchema>

export const copilotProposalInputSchema = z.object({
  agentId: z.string().min(1).max(200),
  targetKind: copilotTargetKindSchema,
  targetId: z.string().max(200).nullable().default(null),
  request: z.string().trim().min(1).max(16_000),
  model: z.string().trim().min(1).max(200).optional(),
})
export type CopilotProposalInput = z.infer<typeof copilotProposalInputSchema>

export const copilotProposalStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "applied",
  "expired",
])
export type CopilotProposalStatus = z.infer<typeof copilotProposalStatusSchema>

export type CopilotProposalRecord = {
  id: string
  projectId: string
  agentId: string
  targetKind: CopilotTargetKind
  targetId: string | null
  status: CopilotProposalStatus
  baseRevision: number
  request: string
  sourceSnapshot: JsonValue
  proposedValue: JsonValue
  diff: JsonValue
  createdAt: string
  createdBy: string | null
  approvedAt: string | null
  approvedBy: string | null
  appliedAt: string | null
}

export type CopilotGenerator = (input: {
  agentId: string
  request: string
  targetKind: CopilotTargetKind
  targetId: string | null
  sourceSnapshot: JsonValue
  model?: string
}) => Promise<{ proposedValue: JsonValue; summary?: string }>

export type CopilotProposalOptions = {
  generate?: CopilotGenerator
}
