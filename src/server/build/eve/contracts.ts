import type { ModelMessage } from "ai"
import type { AgentConfiguration, ActionRecord, ProcedureRecord } from "@/src/lib/build/contracts"
import type { ToolMock } from "@/src/lib/build/testing"
import type { RuntimeContinuation, RuntimeBudgetReservation } from "../runtime"

/** Server-authored, immutable input to one durable Eve execution. No provider keys. */
export type EveExecutionPlan = {
  agent: { id: string; name: string; slug: string; revision: number }
  configuration: AgentConfiguration
  system: string
  messages: ModelMessage[]
  inputText: string
  scopeRestricted: boolean
  sandboxEnabled: boolean
  initialActionRefs: string[]
  integrationMetadata: Record<string, unknown>
  formCompletion: { actionId: string; continuationId: string | null } | null
  budgetReservation: RuntimeBudgetReservation | null
  maxToolSteps: number
  simulation?: { runId: string; caseId: string; leaseOwner: string; toolMocks: readonly ToolMock[]; actions: ActionRecord[]; procedures: ProcedureRecord[] }
}

export type EveExecutionState = {
  actionRefs?: string[]
  procedures?: string[]
  integrationMetadata?: Record<string, unknown>
  continuations?: RuntimeContinuation[]
  handoffOwnerId?: string | null
  modelCalls?: number
  reservedUsd?: number
}

export type EveExecutionOutcome = {
  status: "completed" | "failed" | "cancelled"
  text: string
  error?: { code: string; message: string }
}

export type EveExecution = {
  turnId: string
  projectId: string
  conversationId: string
  agentId: string
  ownerFence: number
  sessionId: string | null
  plan: EveExecutionPlan
  state: EveExecutionState
  outcome: EveExecutionOutcome | null
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
}
