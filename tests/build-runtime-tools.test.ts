import { afterEach, describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"

import type { ActionRecord } from "@/src/lib/build/contracts"
import type { RuntimeAgent } from "@/src/server/build/runtime"
import { runAgentTurn } from "@/src/server/build/runtime"
import { createAgent, getAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction, saveProcedure } from "@/src/server/build/definitions"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  ConversationService,
  type ConversationContext,
} from "@/src/server/build/conversations"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: Array<{ database: TracerDatabase; target: IsolatedPostgres }> =
  []

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeContext() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  await createAgent(
    { database, projectId: target.projectId },
    { id: "agent-a", name: "Test agent", slug: "test-agent" }
  )
  const context: ConversationContext = {
    database,
    projectId: target.projectId,
  }
  return { context, service: new ConversationService(context) }
}

function agent(
  context: ConversationContext,
  overrides: Partial<RuntimeAgent["configuration"]> = {}
): RuntimeAgent {
  return {
    id: "agent-a",
    projectId: context.projectId,
    name: "Support agent",
    slug: "support-agent",
    currentRevision: 4,
    appliedRevision: 4,
    configuration: {
      instructions: "Use the available actions when they solve the request.",
      provider: "project",
      model: "test-model",
      temperature: 0.2,
      channelAllowlist: ["telegram"],
      channelOverrides: {},
      appearance: {
        displayName: "Support",
        avatarUrl: null,
        avatarStyle: "friendly",
        avatarColor: "orange",
        welcomeMessage: "",
        suggestedReplies: [],
        inputPlaceholder: "Message",
        primaryColor: "#111111",
      },
      guardrails: {
        maxInputCharacters: 20_000,
        maxOutputTokens: 4_000,
        maxTurns: 50,
        blockedTopics: [],
        blockedCountries: [],
        spamAfterMessages: null,
        requireHumanForActions: false,
        requestsPerMinute: 60,
        maxConcurrentTurns: 20,
        dailyTurnLimit: null,
        dailyBudgetUsd: null,
      },
      metadata: {},
      ...overrides,
    },
  }
}

const clientAction: ActionRecord = {
  id: "open_ticket",
  projectId: "project",
  agentId: "agent-a",
  slug: "open-ticket",
  revision: 3,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  definition: {
    id: "open_ticket",
    type: "client",
    name: "Open ticket form",
    description: "Open the ticket form in the customer channel.",
    enabled: true,
    channels: ["telegram"],
    procedureOnly: false,
    inputSchema: {},
    eventName: "open_ticket_form",
    resultSchema: {},
  },
}

const handoffAction: ActionRecord = {
  id: "handoff_support",
  projectId: "project",
  agentId: "agent-a",
  slug: "handoff-support",
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  definition: {
    id: "handoff_support",
    type: "handoff",
    name: "Talk to support",
    description: "Connect the customer to a support teammate.",
    enabled: true,
    channels: ["telegram"],
    procedureOnly: false,
    inputSchema: {},
    teamId: "support-team",
    message: "A support teammate will take over.",
    priority: "normal",
  },
}

describe("Build agent tool runtime", () => {
  test("persists a client continuation and the immutable catalog snapshot", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:tool-1",
        requestKey: "telegram:tool-update-1",
        message: "Please open a ticket form",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [clientAction],
          resolveProcedures: async () => [],
          generateText: (async (options: {
            tools: Record<
              string,
              {
                execute: (
                  input: Record<string, unknown>,
                  options: { toolCallId: string }
                ) => Promise<unknown>
              }
            >
          }) => {
            const toolResult = await options.tools.open_ticket.execute(
              { subject: "Login issue" },
              { toolCallId: "tool-call-1" }
            )
            return {
              text: "I opened the ticket form.",
              usage: { inputTokens: 7, outputTokens: 6, totalTokens: 13 },
              toolResult,
            }
          }) as never,
        },
      }
    )

    expect(result.status).toBe("awaiting_client")
    expect(result.continuations[0]).toMatchObject({
      type: "client_action",
      actionId: "open_ticket",
      eventName: "open_ticket_form",
      input: { subject: "Login issue" },
    })
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.status).toBe("awaiting_client")
    expect(result.turn.snapshot).toMatchObject({
      agentRevision: 4,
      actions: [{ id: "open_ticket", revision: 3 }],
    })
    expect(
      (await service.listMessages(result.conversation.id)).items.map(
        (item) => item.role
      )
    ).toEqual(["user", "assistant"])
    const replay = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: result.conversation.id,
        requestKey: "telegram:tool-update-1",
        message: "Please open a ticket form",
        metadata: {},
      },
      { conversationService: service, agent: agent(context) }
    )
    expect(replay.status).toBe("replayed")
    expect(replay.continuations).toHaveLength(1)
    expect(replay.continuations[0]?.type).toBe("client_action")
    expect(replay.continuations[0]?.actionId).toBe("open_ticket")

    const continuationId = replay.continuations[0]?.continuationId as string
    expect(continuationId).toBeTruthy()
    const newerAgent = agent(context)
    newerAgent.currentRevision = 5
    newerAgent.appliedRevision = 5
    const resumed = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: result.conversation.id,
        requestKey: "telegram:tool-resume-1",
        message: "The form is open.",
        metadata: {
          widgetInteraction: {
            actionId: "open_ticket",
            continuationId,
            input: { subject: "Login issue" },
          },
        },
      },
      {
        conversationService: service,
        agent: newerAgent,
        dependencies: {
          resolveActions: async () => [clientAction],
          resolveProcedures: async () => [],
        },
      }
    )
    expect(resumed.status).toBe("awaiting_client")
    expect(resumed.turn.snapshot).toMatchObject({
      agentRevision: 4,
      actions: [{ id: "open_ticket", revision: 3 }],
    })
    await rejects(
      runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "telegram",
          conversationId: result.conversation.id,
          requestKey: "telegram:tool-resume-duplicate",
          message: "The form is open again.",
          metadata: {
            widgetInteraction: {
              actionId: "open_ticket",
              continuationId,
              input: { subject: "Login issue" },
            },
          },
        },
        {
          conversationService: service,
          agent: agent(context),
          dependencies: {
            resolveActions: async () => [clientAction],
            resolveProcedures: async () => [],
          },
        }
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "CONTINUATION_NOT_AVAILABLE"
        )
    )
  }, 30_000)

  test("finalizes the turn before fencing the conversation for a handoff", async () => {
    const { context, service } = await makeContext()
    handoffAction.projectId = context.projectId
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:handoff-1",
        requestKey: "telegram:handoff-1",
        message: "I need a person",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [handoffAction],
          resolveProcedures: async () => [],
          generateText: (async (options: {
            tools: Record<
              string,
              {
                execute: (
                  input: Record<string, unknown>,
                  options: { toolCallId: string }
                ) => Promise<unknown>
              }
            >
          }) => {
            await options.tools.handoff_support.execute(
              {},
              { toolCallId: "handoff-call-1" }
            )
            return {
              text: "A teammate will join this conversation.",
              usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
            }
          }) as never,
        },
      }
    )

    expect(result.status).toBe("handed_off")
    expect(result.conversation.ownerType).toBe("human")
    expect(result.conversation.ownerId).toBe("support-team")
    expect(result.turn.status).toBe("awaiting_client")
    expect(result.toolCalls[0]?.status).toBe("completed")
    expect(result.message?.content).toContain("teammate")
  }, 30_000)

  test("fences a keyword procedure handoff and records its analytics event", async () => {
    const { context, service } = await makeContext()
    handoffAction.projectId = context.projectId
    const savedAction = await saveAction(context, "agent-a", {
      id: handoffAction.id,
      definition: handoffAction.definition,
    })
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "keyword-handoff",
      definition: {
        name: "Keyword handoff",
        trigger: { type: "keyword", value: "validate-agent-handoff" },
        actionRefs: [handoffAction.id],
        steps: [{ id: "handoff", kind: "handoff", actionId: handoffAction.id }],
      },
    })
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:procedure-handoff",
        requestKey: "telegram:procedure-handoff",
        message: "validate-agent-handoff",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [savedAction],
          resolveProcedures: async () => [procedure],
        },
      }
    )

    expect(result.status).toBe("handed_off")
    expect(result.conversation.ownerType).toBe("human")
    const events = await context.database.execute<{ count: string }>(sql`
      select count(*)::text as count
      from build_operation_events
      where project_id=${context.projectId}
        and conversation_id=${result.conversation.id}
        and event_type='handoff'
    `)
    expect(events.rows[0]?.count).toBe("1")
  }, 30_000)

  test("keeps the applied procedure snapshot until the agent is applied", async () => {
    const { context, service } = await makeContext()
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "greeting",
      definition: {
        name: "Greeting",
        trigger: { type: "keyword", value: "hello" },
        steps: [{ id: "message", kind: "message", content: "version one" }],
      },
    })
    await updateAgent(context, "agent-a", { expectedRevision: 1, apply: true })

    const first = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:procedure-v1",
        requestKey: "telegram:procedure-v1",
        message: "hello",
        metadata: {},
      },
      { conversationService: service }
    )
    expect(first.text).toBe("version one")
    expect(first.turn.snapshot.procedures).toEqual([
      { id: procedure.id, revision: 1 },
    ])

    const updated = await saveProcedure(context, "agent-a", {
      id: procedure.id,
      expectedRevision: 1,
      definition: {
        name: "Greeting",
        trigger: { type: "keyword", value: "hello" },
        steps: [{ id: "message", kind: "message", content: "version two" }],
      },
    })
    expect(updated.revision).toBe(2)

    const stillOld = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:procedure-v1-draft",
        requestKey: "telegram:procedure-v1-draft",
        message: "hello",
        metadata: {},
      },
      { conversationService: service }
    )
    expect(stillOld.text).toBe("version one")
    expect(stillOld.turn.snapshot.procedures).toEqual([
      { id: procedure.id, revision: 1 },
    ])

    const current = await getAgent(context, "agent-a")
    await updateAgent(context, "agent-a", {
      expectedRevision: current.currentRevision,
      apply: true,
    })
    const applied = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:procedure-v2",
        requestKey: "telegram:procedure-v2",
        message: "hello",
        metadata: {},
      },
      { conversationService: service }
    )
    expect(applied.text).toBe("version two")
    expect(applied.turn.snapshot.procedures).toEqual([
      { id: procedure.id, revision: 2 },
    ])
  }, 30_000)

  test("does not let public metadata trigger event procedures", async () => {
    const { context, service } = await makeContext()
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "event-greeting",
      definition: {
        name: "Event greeting",
        trigger: { type: "event", value: "ticket.created" },
        steps: [{ id: "message", kind: "message", content: "event handled" }],
      },
    })
    const generateText = (async () => ({
      text: "model handled",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })) as never

    const publicMetadata = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:untrusted-event",
        requestKey: "telegram:untrusted-event-1",
        message: "A ticket was created",
        metadata: { event: "ticket.created" },
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [],
          resolveProcedures: async () => [procedure],
          generateText,
        },
      }
    )
    expect(publicMetadata.text).toBe("model handled")

    const trustedMetadata = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:trusted-event",
        requestKey: "telegram:trusted-event-1",
        message: "A ticket was created",
        metadata: { event: "ticket.created" },
      },
      {
        conversationService: service,
        agent: agent(context),
        trustedMetadata: { event: "ticket.created" },
        dependencies: {
          resolveActions: async () => [],
          resolveProcedures: async () => [procedure],
          generateText,
        },
      }
    )
    expect(trustedMetadata.text).toBe("event handled")
  }, 30_000)

  test("exposes intent procedures as bounded model tools", async () => {
    const { context, service } = await makeContext()
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "lookup-order",
      definition: {
        name: "Lookup order",
        description: "Use this when the customer needs an order lookup.",
        trigger: { type: "intent", value: "lookup_order" },
        steps: [{ id: "message", kind: "message", content: "order found" }],
      },
    })
    let modelCalls = 0
    const modelWithoutProcedure = (async () => {
      modelCalls += 1
      return {
        text: "model handled",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    }) as never
    const publicIntent = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:public-intent",
        requestKey: "telegram:public-intent-1",
        message: "Can you look up my order?",
        metadata: { intent: "lookup_order" },
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [],
          resolveProcedures: async () => [procedure],
          generateText: modelWithoutProcedure,
        },
      }
    )
    expect(publicIntent.text).toBe("model handled")
    expect(modelCalls).toBe(1)

    const modelWithProcedure = (async (options: {
      tools: Record<
        string,
        {
          execute: (
            input: Record<string, unknown>,
            options: { toolCallId: string }
          ) => Promise<unknown>
        }
      >
    }) => {
      const output = await options.tools[`procedure_${procedure.id}`].execute(
        {},
        { toolCallId: "intent-procedure-call-1" }
      )
      return {
        text: (output as { text: string }).text,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    }) as never
    const invoked = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:model-intent",
        requestKey: "telegram:model-intent-1",
        message: "Can you look up my order?",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [],
          resolveProcedures: async () => [procedure],
          generateText: modelWithProcedure,
        },
      }
    )
    expect(invoked.text).toBe("order found")
    expect(invoked.status).toBe("completed")
  }, 30_000)

  test("runs only the selected manual procedure through the trusted operation boundary", async () => {
    const { context, service } = await makeContext()
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "manual-reindex",
      definition: {
        name: "Manual reindex",
        trigger: { type: "manual", value: "manual-reindex" },
        steps: [{ id: "message", kind: "message", content: "reindexed" }],
      },
    })
    await updateAgent(context, "agent-a", { expectedRevision: 1, apply: true })

    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:manual-procedure",
        requestKey: "telegram:manual-procedure-1",
        message: "",
        metadata: {},
      },
      {
        conversationService: service,
        requiredProcedureId: procedure.id,
        trustedMetadata: { procedureId: procedure.id },
      }
    )
    expect(result.text).toBe("reindexed")
    expect(result.status).toBe("completed")
  }, 30_000)

  test("pauses procedure steps at approval and resumes the pinned cursor once", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    await saveAction(context, "agent-a", {
      id: clientAction.id,
      slug: clientAction.slug,
      definition: clientAction.definition,
    })
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "approval-flow",
      definition: {
        name: "Approval flow",
        trigger: { type: "keyword", value: "run approval flow" },
        steps: [
          { id: "before", kind: "message", content: "before approval" },
          {
            id: "action",
            kind: "action",
            actionId: clientAction.id,
            input: {},
          },
          { id: "after", kind: "message", content: "after approval" },
        ],
      },
    })
    const guardedAgent = agent(context, {
      guardrails: {
        ...agent(context).configuration.guardrails,
        requireHumanForActions: true,
      },
    })
    const executeCalls: string[] = []
    const dependencies = {
      resolveActions: async () => [clientAction],
      resolveProcedures: async () => [procedure],
      executeAction: async ({ toolCallId }: { toolCallId: string }) => {
        executeCalls.push(toolCallId)
        return { output: { approved: true } }
      },
      generateText: (async () => ({
        text: "model should not run",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })) as never,
    }
    const pending = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:approval-flow",
        requestKey: "telegram:approval-flow-1",
        message: "Please run approval flow",
        metadata: {},
      },
      { conversationService: service, agent: guardedAgent, dependencies }
    )
    expect(pending.text).toBe("before approval")
    expect(pending.text).not.toContain("after approval")
    const continuation = pending.continuations[0]
    expect(continuation?.type).toBe("approval_required")
    expect(continuation?.procedureCursor).toMatchObject({
      procedureId: procedure.id,
      procedureRevision: procedure.revision,
    })
    const approvalContinuationId = continuation?.continuationId
    if (typeof approvalContinuationId !== "string")
      throw new Error("Approval procedure did not persist a continuation id.")

    const resumed = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: pending.conversation.id,
        requestKey: "telegram:approval-flow-2",
        message: "Approve it",
        metadata: {
          widgetInteraction: {
            actionId: clientAction.id,
            continuationId: approvalContinuationId,
            input: {},
          },
        },
      },
      {
        conversationService: service,
        agent: guardedAgent,
        dependencies,
        trustedApproval: {
          actionId: clientAction.id,
          continuationId: approvalContinuationId,
        },
      }
    )
    expect(resumed.status).toBe("completed")
    expect(resumed.text).toContain("after approval")
    expect(executeCalls).toHaveLength(1)
  }, 30_000)

  test("completes a client continuation before resuming its pinned cursor", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    await saveAction(context, "agent-a", {
      id: clientAction.id,
      slug: clientAction.slug,
      definition: clientAction.definition,
    })
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "client-flow",
      definition: {
        name: "Client flow",
        trigger: { type: "keyword", value: "run client flow" },
        steps: [
          { id: "before", kind: "message", content: "before client" },
          {
            id: "action",
            kind: "action",
            actionId: clientAction.id,
            input: {},
          },
          { id: "after", kind: "message", content: "after client" },
        ],
      },
    })
    const dependencies = {
      resolveActions: async () => [clientAction],
      resolveProcedures: async () => [procedure],
      generateText: (async () => ({
        text: "model should not run",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })) as never,
    }
    const pending = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:client-flow",
        requestKey: "telegram:client-flow-1",
        message: "Please run client flow",
        metadata: {},
      },
      { conversationService: service, agent: agent(context), dependencies }
    )
    expect(pending.text).toBe("before client")
    expect(pending.continuations[0]?.type).toBe("client_action")
    const continuationId = pending.continuations[0]?.continuationId
    if (typeof continuationId !== "string")
      throw new Error("Client procedure did not persist a continuation id.")

    const resumed = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: pending.conversation.id,
        requestKey: "telegram:client-flow-2",
        message: "The client action completed",
        metadata: {
          widgetInteraction: {
            actionId: clientAction.id,
            continuationId,
            input: { accepted: true },
          },
        },
      },
      { conversationService: service, agent: agent(context), dependencies }
    )
    expect(resumed.status).toBe("completed")
    expect(resumed.text).toBe("after client")
    expect(resumed.continuations).toHaveLength(0)
  }, 30_000)

  test("keeps wait procedures resumable until an authenticated elapsed resume", async () => {
    const { context, service } = await makeContext()
    const procedure = await saveProcedure(context, "agent-a", {
      slug: "wait-flow",
      definition: {
        name: "Wait flow",
        trigger: { type: "keyword", value: "run wait flow" },
        steps: [
          { id: "before", kind: "message", content: "before wait" },
          { id: "wait", kind: "wait", seconds: 0 },
          { id: "after", kind: "message", content: "after wait" },
        ],
      },
    })
    const dependencies = {
      resolveActions: async () => [],
      resolveProcedures: async () => [procedure],
      generateText: (async () => ({
        text: "model should not run",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })) as never,
    }
    const pending = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:wait-flow",
        requestKey: "telegram:wait-flow-1",
        message: "Please run wait flow",
        metadata: {},
      },
      { conversationService: service, agent: agent(context), dependencies }
    )
    const continuation = pending.continuations[0]
    expect(pending.text).toBe("before wait")
    expect(continuation).toMatchObject({
      type: "wait",
      actionId: "__wait__",
      procedureCursor: {
        procedureId: procedure.id,
        procedureRevision: procedure.revision,
      },
    })
    const waitContinuationId = continuation?.continuationId
    if (typeof waitContinuationId !== "string")
      throw new Error("Wait procedure did not persist a continuation id.")

    const resumed = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: pending.conversation.id,
        requestKey: "telegram:wait-flow-2",
        message: "Resume the wait",
        metadata: {
          widgetInteraction: {
            actionId: "__wait__",
            continuationId: waitContinuationId,
            input: {},
          },
        },
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies,
        trustedWaitContinuationId: waitContinuationId,
      }
    )
    expect(resumed.status).toBe("completed")
    expect(resumed.text).toBe("after wait")
  }, 30_000)

  test("requires a trusted approval boundary before executing guarded actions", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    const guardedAgent = agent(context, {
      guardrails: {
        ...agent(context).configuration.guardrails,
        requireHumanForActions: true,
      },
    })
    const executeCalls: string[] = []
    const generateText = (async (options: {
      tools: Record<
        string,
        {
          execute: (
            input: Record<string, unknown>,
            options: { toolCallId: string }
          ) => Promise<unknown>
        }
      >
    }) => {
      const output = await options.tools.open_ticket.execute(
        { subject: "Guarded" },
        { toolCallId: "guarded-call-1" }
      )
      return {
        text: "Approval requested.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      }
    }) as never
    const dependencies = {
      resolveActions: async () => [clientAction],
      resolveProcedures: async () => [],
      generateText,
      executeAction: async ({ toolCallId }: { toolCallId: string }) => {
        executeCalls.push(toolCallId)
        return { output: { ok: true } }
      },
    }
    const pending = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:guarded-action",
        requestKey: "telegram:guarded-action-1",
        message: "Open the guarded form",
        metadata: {},
      },
      { conversationService: service, agent: guardedAgent, dependencies }
    )
    expect(pending.continuations[0]?.type).toBe("approval_required")
    const continuationId = pending.continuations[0]?.continuationId as string

    await rejects(
      runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "telegram",
          conversationId: pending.conversation.id,
          requestKey: "telegram:guarded-action-untrusted",
          message: "Approve it",
          metadata: {
            widgetInteraction: {
              actionId: "open_ticket",
              continuationId,
              input: { subject: "Tampered" },
            },
          },
        },
        { conversationService: service, agent: guardedAgent, dependencies }
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "CONTINUATION_NOT_AVAILABLE"
        )
    )
    expect(executeCalls).toEqual([])

    const approved = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: pending.conversation.id,
        requestKey: "telegram:guarded-action-approved",
        message: "Approve it",
        metadata: {
          widgetInteraction: {
            actionId: "open_ticket",
            continuationId,
            input: { subject: "Tampered" },
          },
        },
      },
      {
        conversationService: service,
        agent: guardedAgent,
        trustedApproval: { actionId: "open_ticket", continuationId },
        dependencies,
      }
    )
    expect(approved.status).toBe("completed")
    expect(executeCalls).toEqual(["guarded-call-1"])
  }, 30_000)

  test("records one bounded agent and tool failure event across a failed retry", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    const generateText = (async (options: {
      tools: Record<
        string,
        {
          execute: (
            input: Record<string, unknown>,
            options: { toolCallId: string }
          ) => Promise<unknown>
        }
      >
    }) => {
      await options.tools.open_ticket.execute(
        { subject: "Failure question" },
        { toolCallId: "failure-call-1" }
      )
      return { text: "unreachable" }
    }) as never
    const dependencies = {
      resolveActions: async () => [clientAction],
      resolveProcedures: async () => [],
      generateText,
      executeAction: async () => {
        throw new Error("provider action failed")
      },
    }
    await rejects(
      runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "telegram",
          externalConversationId: "telegram:failure-events",
          requestKey: "telegram:failure-events-1",
          message: "Failure question",
          metadata: {},
        },
        { conversationService: service, agent: agent(context), dependencies }
      )
    )
    const conversation = await service.getByExternalId(
      "agent-a",
      "telegram",
      "telegram:failure-events"
    )
    expect(conversation).not.toBeNull()
    const replay = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        conversationId: conversation!.id,
        requestKey: "telegram:failure-events-1",
        message: "Failure question",
        metadata: {},
      },
      { conversationService: service, agent: agent(context) }
    )
    expect(replay.status).toBe("replayed")
    const events = await context.database.execute<{
      event_type: string
      payload_json: Record<string, unknown>
    }>(sql`
      SELECT event_type, payload_json
      FROM build_operation_events
      WHERE project_id = ${context.projectId}
        AND conversation_id = ${conversation!.id}
      ORDER BY id
    `)
    expect(events.rows.map((row) => row.event_type).sort()).toEqual([
      "agent_failed",
      "tool_failed",
    ])
    expect(
      events.rows.every(
        (row) => row.payload_json.question === "Failure question"
      )
    ).toBe(true)
  }, 30_000)

  test("records a tool failure when an action reports a failed result", async () => {
    const { context, service } = await makeContext()
    clientAction.projectId = context.projectId
    const generateText = (async (options: {
      tools: Record<
        string,
        {
          execute: (
            input: Record<string, unknown>,
            options: { toolCallId: string }
          ) => Promise<unknown>
        }
      >
    }) => {
      const output = await options.tools.open_ticket.execute(
        { subject: "Failed action" },
        { toolCallId: "failed-result-call-1" }
      )
      return {
        text: "The action could not be completed.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      }
    }) as never
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        externalConversationId: "telegram:failed-result",
        requestKey: "telegram:failed-result-1",
        message: "Try the ticket action",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context),
        dependencies: {
          resolveActions: async () => [clientAction],
          resolveProcedures: async () => [],
          generateText,
          executeAction: async () => ({
            status: "failed" as const,
            output: { error: "provider rejected the request" },
          }),
        },
      }
    )
    expect(result.status).toBe("completed")
    const events = await context.database.execute<{ event_type: string }>(sql`
      SELECT event_type
      FROM build_operation_events
      WHERE project_id = ${context.projectId}
        AND conversation_id = ${result.conversation.id}
      ORDER BY id
    `)
    expect(events.rows.map((row) => row.event_type)).toEqual(["tool_failed"])
  }, 30_000)
})
