import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"

import { simulationResultStatus } from "../src/lib/build/testing"
import { createBuildContext } from "../src/server/build/context"
import { createAgent, updateAgent } from "../src/server/build/agents"
import { saveAction } from "../src/server/build/definitions"
import {
  addSimulationToolMock,
  cancelSimulationRun,
  createSimulationDefinition,
  getSimulationRun,
  listSimulationCases,
  listSimulationProjectsWithPendingRuns,
  recoverSimulationRun,
  runQueuedSimulationRuns,
  startSimulationRun,
} from "../src/server/build/testing/service"
import {
  applyCopilotProposal,
  approveCopilotProposal,
  createCopilotProposal,
  listCopilotAudit,
} from "../src/server/build/copilot/service"
import type { JsonValue } from "../src/lib/tracer/contracts"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { getTracerProjectId } from "../src/server/tracer/db"

function snapshot() {
  return {
    agentRevision: 1,
    config: { instructions: "original", model: "test-model", temperature: 0.1 },
    actions: [],
    procedures: [],
    widgets: [],
    knowledge: [],
    capturedAt: new Date().toISOString(),
  }
}

async function fixture() {
  const db = await createTracerFixture()
  const context = createBuildContext(db, {
    projectId: getTracerProjectId(db),
    actorId: "test-actor",
  })
  const agent = await createAgent(context, {
    name: `Test agent ${crypto.randomUUID()}`,
    configuration: {
      instructions: "original",
      model: "test-model",
      temperature: 0.1,
    },
  })
  return { db, context, agent }
}

test("simulation runs freeze configuration and expand every model/repeat variant", async () => {
  const { db, context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Checkout ${crypto.randomUUID()}`,
        scenario: "A customer wants to complete checkout.",
        initialMessage: "I need help checking out.",
        successCriteria: ["The customer receives useful checkout help."],
        expectedActions: [{ actionId: "lookup_order" }],
        models: ["model-a"],
      },
    })
    await addSimulationToolMock(context, agent.id, definition.id, {
      matcher: { actionId: "lookup_order", match: "action" },
      response: { state: "ready" },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      models: ["model-a", "model-b"],
      repeats: 2,
    })
    expect(run.requestedCases).toBe(4)
    expect(run.configSnapshot.config).toMatchObject({
      instructions: "original",
      model: "test-model",
      temperature: 0.1,
    })
    await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        instructions: "changed after queue",
        model: "test-model",
        temperature: 0.2,
      },
    })
    const cases = await listSimulationCases(context, run.id)
    expect(cases).toHaveLength(4)
    expect(new Set(cases.map((item) => item.variantKey))).toEqual(
      new Set(["model-a:1", "model-a:2", "model-b:1", "model-b:2"])
    )
    expect(
      (await getSimulationRun(context, run.id)).configSnapshot.config
    ).toMatchObject({
      instructions: "original",
      model: "test-model",
      temperature: 0.1,
    })
  } finally {
    await closeTracerFixture(db)
  }
})

test("simulation snapshots redact credential-shaped configuration and action handles", async () => {
  const { db, context, agent } = await fixture()
  const previousEncryptionKey = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    previousEncryptionKey ?? "build-testing-secret-0123456789abcdef"
  try {
    const action = await saveAction(context, agent.id, {
      slug: `lookup-${crypto.randomUUID()}`,
      definition: {
        type: "http",
        name: "Lookup",
        method: "GET",
        url: "https://example.test/lookup",
        headers: { Authorization: "Bearer simulation-secret" },
      },
    })
    const updated = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        ...agent.configuration,
        metadata: { apiToken: "simulation-secret" },
      },
    })
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Secret snapshot ${crypto.randomUUID()}`,
        scenario: "A customer asks for a lookup.",
        initialMessage: "Look this up.",
        successCriteria: ["The customer receives a useful answer."],
        expectedActions: [{ actionId: action.id }],
        models: ["model-a"],
      },
    })
    const run = await startSimulationRun(context, agent.id, definition.id)
    expect(JSON.stringify(run.configSnapshot)).not.toContain(
      "simulation-secret"
    )
    expect(run.configSnapshot.config).toMatchObject({
      metadata: { apiToken: "__REDACTED__" },
    })
    expect(updated.currentRevision).toBe(2)
  } finally {
    if (previousEncryptionKey === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousEncryptionKey
    await closeTracerFixture(db)
  }
})

test("simulation execution only allows mocked tools and keeps verdict classes distinct", async () => {
  const { db, context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Verdict classes ${crypto.randomUUID()}`,
        scenario: "A customer asks for an order update.",
        initialMessage: "Where is order 123?",
        successCriteria: ["The order state is explained."],
        expectedActions: [{ actionId: "lookup_order" }],
        models: ["pass", "no-verdict", "infra"],
      },
    })
    await addSimulationToolMock(context, agent.id, definition.id, {
      matcher: {
        actionId: "lookup_order",
        match: "exact",
        arguments: { orderId: "123" },
      },
      response: { state: "shipped" },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => snapshot(),
    })
    const completedRuns = await runQueuedSimulationRuns(
      context,
      async ({ testCase, callMockedTool, renewLease }) => {
        await renewLease()
        if (testCase.model === "infra") throw new Error("provider unavailable")
        if (testCase.model === "no-verdict")
          return {
            transcript: [
              {
                role: "user",
                content: "Where is order 123?",
                turn: 0,
                metadata: {},
              },
            ],
            observedActions: [],
            verdict: {
              status: "no_verdict",
              reason: "Judge timed out",
              criteria: [],
              score: null,
            },
          }
        const toolResult = await callMockedTool("lookup_order", {
          orderId: "123",
        })
        return {
          transcript: [
            {
              role: "user",
              content: "Where is order 123?",
              turn: 0,
              metadata: {},
            },
            {
              role: "tool",
              content: JSON.stringify(toolResult.response),
              turn: 1,
              metadata: {},
            },
            {
              role: "assistant",
              content: "It has shipped.",
              turn: 1,
              metadata: {},
            },
          ],
          observedActions: [
            {
              actionId: "lookup_order",
              arguments: { orderId: "123" },
              status: "succeeded",
              result: toolResult.response as never,
            },
          ],
          verdict: {
            status: "passed",
            reason: "All criteria met",
            criteria: [
              {
                criterion: "The order state is explained.",
                passed: true,
                reason: "The model used the mocked order state.",
              },
            ],
            score: 1,
          },
        }
      },
      { maxRuns: 1 }
    )
    expect(completedRuns).toHaveLength(1)
    const completed = completedRuns[0]!
    expect(completed.status).toBe("completed")
    expect(completed.passedCases).toBe(1)
    expect(completed.noVerdictCases).toBe(1)
    expect(completed.infraErrorCases).toBe(1)
    const cases = await listSimulationCases(context, run.id)
    expect(cases.find((item) => item.model === "infra")?.verdict?.status).toBe(
      "infra_error"
    )
    expect(
      cases.find((item) => item.model === "no-verdict")?.verdict?.status
    ).toBe("no_verdict")
    expect(cases.find((item) => item.model === "pass")?.verdict?.status).toBe(
      "passed"
    )
    expect(
      simulationResultStatus(
        cases.find((item) => item.model === "pass")?.verdict
      )
    ).toBe("pass")
    expect(
      simulationResultStatus(
        cases.find((item) => item.model === "no-verdict")?.verdict
      )
    ).toBe("inconclusive")
    expect(
      simulationResultStatus(
        cases.find((item) => item.model === "infra")?.verdict
      )
    ).toBe("error")
  } finally {
    await closeTracerFixture(db)
  }
})

test("cancel fences queued cases and recovery takes an expired lease", async () => {
  const { db, context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Lifecycle ${crypto.randomUUID()}`,
        scenario: "A customer needs help.",
        initialMessage: "Hello",
        successCriteria: ["The customer gets an answer."],
      },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => snapshot(),
    })
    expect(await listSimulationProjectsWithPendingRuns(db)).toEqual([
      context.projectId,
    ])
    await cancelSimulationRun(context, run.id)
    expect((await getSimulationRun(context, run.id)).status).toBe("cancelled")
    expect((await listSimulationCases(context, run.id))[0]?.status).toBe(
      "cancelled"
    )

    const recoverable = await startSimulationRun(
      context,
      agent.id,
      definition.id,
      { snapshotLoader: async () => snapshot() }
    )
    await db.execute(
      sql`UPDATE build_test_runs SET status = 'running', lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 minute' WHERE project_id = ${context.projectId} AND id = ${recoverable.id}`
    )
    const lease = await recoverSimulationRun(context, recoverable.id)
    expect(lease?.runId).toBe(recoverable.id)
  } finally {
    await closeTracerFixture(db)
  }
})

test("copilot proposals are reviewable, audited, and revision-protected before apply", async () => {
  const { db, context, agent } = await fixture()
  try {
    const proposal = await createCopilotProposal(
      context,
      {
        agentId: agent.id,
        targetKind: "instructions",
        targetId: null,
        request: "Make the assistant concise.",
      },
      {
        generator: async ({ sourceSnapshot }) => {
          const current = sourceSnapshot as { value: Record<string, unknown> }
          return {
            proposedValue: {
              ...current.value,
              instructions: "Be concise and direct.",
            },
            summary: "Shorten the instruction style.",
          }
        },
      }
    )
    expect(proposal.status).toBe("proposed")
    expect(proposal.diff).toBeTruthy()
    await approveCopilotProposal(context, proposal.id)
    const applied = await applyCopilotProposal(context, proposal.id)
    expect(applied.status).toBe("applied")
    expect(
      (await listCopilotAudit(context, proposal.id)).map((event) => event.event)
    ).toEqual(["created", "approved", "applied"])

    const stale = await createCopilotProposal(
      context,
      {
        agentId: agent.id,
        targetKind: "instructions",
        targetId: null,
        request: "Change this later.",
      },
      {
        generator: async ({ sourceSnapshot }) => ({
          proposedValue: (sourceSnapshot as { value: JsonValue }).value,
        }),
      }
    )
    await approveCopilotProposal(context, stale.id)
    await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision + 1,
      configuration: {
        instructions: "changed independently",
        model: "test-model",
        temperature: 0.3,
      },
    })
    await rejects(
      applyCopilotProposal(context, stale.id),
      /changed after this proposal/i
    )
  } finally {
    await closeTracerFixture(db)
  }
})
