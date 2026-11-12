import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"

import { createBuildContext } from "../src/server/build/context"
import { createAgent } from "../src/server/build/agents"
import { saveAction } from "../src/server/build/definitions"
import { createRuntimeSimulationExecutor } from "../src/server/build/testing/runtime-executor"
import {
  addSimulationToolMock,
  cancelSimulationRun,
  captureSimulationConfig,
  createSimulationDefinition,
  getSimulationRun,
  listSimulationCases,
  runQueuedSimulationRuns,
  startSimulationRun,
} from "../src/server/build/testing/service"
import { createEveFixture, invokeTool, eveResponse } from "./helpers/eve-fixture"
let activeEve: Awaited<ReturnType<typeof createEveFixture>>
async function fixture() {
  activeEve = await createEveFixture()
  const db = activeEve.context.database
  const context = createBuildContext(db, {
    projectId: activeEve.context.projectId,
    actorId: "simulation-runtime-test",
  })
  const agent = await createAgent(context, {
    name: `Runtime simulation ${crypto.randomUUID()}`,
    configuration: {
      instructions: "Use the lookup action before answering order questions.",
      provider: "openai", model: "gpt-4.1-mini", guardrails: { jevCheckEnabled: false },
      channelAllowlist: ["telegram"],
    },
  })
  await saveAction(context, agent.id, {
    id: "lookup_order",
    slug: "lookup_order",
    definition: {
      type: "http",
      id: "lookup_order",
      name: "Lookup order",
      description: "Look up the order state.",
      enabled: true,
      channels: ["telegram"],
      procedureOnly: false,
      inputSchema: {},
      method: "POST",
      url: "https://example.invalid/orders",
      headers: {},
      bodyTemplate: null,
      responseSchema: {},
      timeoutMs: 500,
    },
  })
  return { db, context, agent }
}

function scriptAgent() {
  activeEve.provider(body => invokeTool(body, { orderId: "123" }, "The order state is shipped."))
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

test("runtime simulation executes the real agent loop against mocked actions", async () => {
  const { context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Runtime mock boundary ${crypto.randomUUID()}`,
        channel: "telegram",
        persona: {
          name: "Customer",
          traits: ["concise"],
          goals: ["know the order state"],
          context: "Order 123 exists.",
        },
        scenario: "A customer asks for the state of order 123.",
        initialMessage: "Where is order 123?",
        successCriteria: ["The order state is explained."],
        expectedActions: [
          {
            actionId: "lookup_order",
            arguments: { orderId: "123" },
          },
        ],
        models: ["simulation-model"],
        maxTurns: 1,
      },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => captureSimulationConfig(context, agent.id),
      models: ["simulation-model"],
    })
    await addSimulationToolMock(context, agent.id, definition.id, {
      matcher: {
        actionId: "lookup_order",
        match: "exact",
        arguments: { orderId: "123" },
      },
      response: { state: "shipped" },
    })
    scriptAgent()
    let structuredJudgeCalls = 0
    const executor = createRuntimeSimulationExecutor(context, {

      generateObject: (async (options: unknown) => {
        if (
          (options as { schemaName?: string }).schemaName ===
          "simulation_verdict"
        )
          structuredJudgeCalls += 1
        return {
          object: {
            status: "passed",
            reason: "The mocked lookup was used.",
            criteria: [
              {
                criterion: "The order state is explained.",
                passed: true,
                reason: "The agent used the mocked order lookup.",
              },
            ],
            score: 1,
          },
        }
      }) as never,
      customer: null,
    })
    await runQueuedSimulationRuns(context, executor)
    const completed = await getSimulationRun(context, run.id)
    expect(completed.status).toBe("completed")
    expect(completed.passedCases).toBe(1)
    expect(structuredJudgeCalls).toBe(1)
    const result = (await listSimulationCases(context, run.id))[0]
    expect(result?.verdict?.status).toBe("passed")
    const observed = result?.observedActions.find(
      (action) => action.actionId === "lookup_order"
    )
    expect(observed).toMatchObject({
      actionId: "lookup_order",
      status: "succeeded",
      result: { state: "shipped" },
    })
  } finally {
    await activeEve.close()
  }
})

test("runtime simulation preserves no_verdict and provider failures", async () => {
  const { context, agent } = await fixture()
  try {
    const noJudgeDefinition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `No judge ${crypto.randomUUID()}`,
        channel: "telegram",
        scenario: "A customer says hello.",
        initialMessage: "Hello",
        successCriteria: ["The customer is greeted."],
        models: ["simulation-model"],
        maxTurns: 1,
      },
    })
    const noJudgeRun = await startSimulationRun(
      context,
      agent.id,
      noJudgeDefinition.id,
      { snapshotLoader: async () => captureSimulationConfig(context, agent.id) }
    )
    await runQueuedSimulationRuns(
      context,
      createRuntimeSimulationExecutor(context, {

        customer: null,
        judge: null,
      })
    )
    expect(
      (await listSimulationCases(context, noJudgeRun.id))[0]?.verdict?.status
    ).toBe("no_verdict")

    const infraDefinition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Provider failure ${crypto.randomUUID()}`,
        channel: "telegram",
        scenario: "A customer says hello.",
        initialMessage: "Hello",
        successCriteria: ["The customer is greeted."],
        models: ["simulation-model"],
        maxTurns: 1,
      },
    })
    const infraRun = await startSimulationRun(
      context,
      agent.id,
      infraDefinition.id,
      { snapshotLoader: async () => captureSimulationConfig(context, agent.id) }
    )
    activeEve.provider(() => Response.json({ error: { message: "private provider diagnostic" } }, { status: 403 }))
    await runQueuedSimulationRuns(
      context,
      createRuntimeSimulationExecutor(context, { customer: null, judge: null })
    )
    const infraCase = (await listSimulationCases(context, infraRun.id))[0]
    expect(infraCase?.verdict?.status).toBe("infra_error")
    expect((await getSimulationRun(context, infraRun.id)).infraErrorCases).toBe(
      1
    )
  } finally {
    await activeEve.close()
  }
})

test("runtime simulation cannot pass a required action that returned a mock error", async () => {
  const { context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Mock action failure ${crypto.randomUUID()}`,
        channel: "telegram",
        scenario: "A customer asks for an order state.",
        initialMessage: "Where is order 123?",
        successCriteria: ["The order state is explained."],
        expectedActions: [{ actionId: "lookup_order" }],
        models: ["simulation-model"],
        maxTurns: 1,
      },
    })
    await addSimulationToolMock(context, agent.id, definition.id, {
      matcher: { actionId: "lookup_order", match: "action" },
      error: "Mocked order service unavailable.",
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => captureSimulationConfig(context, agent.id),
    })
    scriptAgent()
    await runQueuedSimulationRuns(
      context,
      createRuntimeSimulationExecutor(context, {

        customer: null,
        judge: async () => ({
          status: "passed",
          reason: "The judge must be fenced by failed required actions.",
          criteria: [
            {
              criterion: "The order state is explained.",
              passed: true,
              reason:
                "This is intentionally inconsistent with the failed mock.",
            },
          ],
          score: 1,
        }),
      })
    )
    const result = (await listSimulationCases(context, run.id))[0]
    expect(result?.verdict?.status).toBe("failed")
    expect(result?.verdict?.reason).toContain(
      "Required actions were not observed"
    )
  } finally {
    await activeEve.close()
  }
})

test("runtime simulation renews the lease during a long model call", async () => {
  const { db, context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Long model call ${crypto.randomUUID()}`,
        channel: "telegram",
        scenario: "A customer says hello.",
        initialMessage: "Hello",
        successCriteria: ["The customer is greeted."],
        models: ["simulation-model"],
        maxTurns: 1,
      },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => captureSimulationConfig(context, agent.id),
    })
    const pump = runQueuedSimulationRuns(
      context,
      createRuntimeSimulationExecutor(context, {

        customer: null,
        judge: async () => {
          await delay(5_500)
          return {
            status: "passed" as const,
            reason: "The model completed after a heartbeat renewal.",
            criteria: [
              {
                criterion: "The customer is greeted.",
                passed: true,
                reason: "The model returned a greeting.",
              },
            ],
            score: 1,
          }
        },
      }),
      { leaseSeconds: 5 }
    )
    await delay(5_200)
    const lease = await db.execute<{
      run_lease_expires_at: string
      case_lease_expires_at: string
    }>(sql`
      SELECT r.lease_expires_at AS run_lease_expires_at,
             c.lease_expires_at AS case_lease_expires_at
      FROM build_test_runs r
      JOIN build_test_cases c
        ON c.project_id = r.project_id AND c.run_id = r.id
      WHERE r.project_id = ${context.projectId} AND r.id = ${run.id}
    `)
    expect(
      new Date(lease.rows[0]!.run_lease_expires_at).getTime()
    ).toBeGreaterThan(Date.now())
    expect(
      new Date(lease.rows[0]!.case_lease_expires_at).getTime()
    ).toBeGreaterThan(Date.now())
    const completed = (await pump)[0]
    expect(completed?.status).toBe("completed")
  } finally {
    await activeEve.close()
  }
}, 30_000)

test("runtime simulation aborts an in-flight model and does not continue after cancellation", async () => {
  const { context, agent } = await fixture()
  try {
    const definition = await createSimulationDefinition(context, {
      agentId: agent.id,
      definition: {
        name: `Cancellation fence ${crypto.randomUUID()}`,
        channel: "telegram",
        scenario: "A customer asks for help.",
        initialMessage: "Help",
        successCriteria: ["The customer receives help."],
        models: ["simulation-model"],
        maxTurns: 3,
      },
    })
    const run = await startSimulationRun(context, agent.id, definition.id, {
      snapshotLoader: async () => captureSimulationConfig(context, agent.id),
    })
    let modelCalls = 0
    let customerCalls = 0
    let judgeCalls = 0
    let release: (() => void) | undefined
    activeEve.provider(body => {
      modelCalls++
      return new Promise<Response>(resolve => { release = () => resolve(eveResponse(body, "Help is available.")) })
    })
    const pump = runQueuedSimulationRuns(
      context,
      createRuntimeSimulationExecutor(context, {
        customer: async () => {
          customerCalls += 1
          return { message: "Continue", done: false }
        },
        judge: async () => {
          judgeCalls += 1
          return {
            status: "passed",
            reason: "Should not run after cancellation.",
            criteria: [],
            score: 1,
          }
        },
      }),
      { leaseSeconds: 5 }
    )
    while (!modelCalls) await delay(50)
    await cancelSimulationRun(context, run.id)
    const completed = (await pump)[0]
    release?.()
    expect(completed?.status).toBe("cancelled")
    expect(modelCalls).toBe(1)
    expect(customerCalls).toBe(0)
    expect(judgeCalls).toBe(0)
    expect((await listSimulationCases(context, run.id))[0]?.status).toBe(
      "cancelled"
    )
  } finally {
    await activeEve.close()
  }
}, 30_000)
