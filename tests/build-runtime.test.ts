import { afterEach, describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { generateText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import type { ActionRecord } from "@/src/lib/build/contracts"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"

import type { RuntimeAgent } from "@/src/server/build/runtime"
import { runAgentTurn, BuildRuntimeError } from "@/src/server/build/runtime"
import { createAgent } from "@/src/server/build/agents"
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
    currentRevision: 1,
    appliedRevision: 1,
    configuration: {
      instructions: "Answer customer questions clearly.",
      provider: "project",
      model: "",
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
    } as RuntimeAgent["configuration"],
  }
}

describe("Build agent runtime", () => {
  test("retains the safe HTTP failure status in tool traces", async () => {
    const { context, service } = await makeContext()
    const usage = {
      inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    }
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "products-1",
              toolName: "products",
              input: '{"query":""}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            { type: "text", text: "Store data is temporarily unavailable." },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        },
      ],
    })
    const action: ActionRecord = {
      id: "products",
      projectId: context.projectId,
      agentId: "agent-a",
      slug: "products",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      definition: {
        id: "products",
        type: "client",
        name: "Products",
        description: "Find products",
        enabled: true,
        channels: ["telegram"],
        procedureOnly: false,
        eventName: "products",
        resultSchema: {},
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    }
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        requestKey: "http-failure-trace",
        message: "What products do you sell?",
      },
      {
        conversationService: service,
        agent: agent(context, { model: "trace-test-model" }),
        dependencies: {
          generateText: (options) => generateText({ ...options, model }),
          resolveActions: async () => [action],
          resolveProcedures: async () => [],
          executeAction: async () => {
            throw new BuildRuntimeError(
              "ACTION_HTTP_ERROR",
              "The outbound action returned HTTP 502."
            )
          },
        },
      }
    )
    const trace = await runTracerEffect(
      new TracerService(context.database).getTrace(result.traceId!)
    )
    const tool = trace.spans.find((span) => span.kind === "tool")
    expect(tool?.status).toBe("errored")
    expect(tool?.attributes["error.message"]).toBe(
      "The outbound action returned HTTP 502."
    )
    expect(result.toolCalls[0]?.error).toMatchObject({
      kind: "ACTION_HTTP_ERROR",
      message: "The outbound action returned HTTP 502.",
    })
  }, 30_000)
  test("captures each real model call, including instructions, history and tool results", async () => {
    const { context, service } = await makeContext()
    const conversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      metadata: {},
    })
    await service.appendMessage(conversation.id, {
      role: "user",
      content: "My account is 42",
      status: "completed",
      metadata: {},
    })
    await service.appendMessage(conversation.id, {
      role: "assistant",
      content: "How can I help?",
      status: "completed",
      metadata: {},
    })
    const usage = {
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 3, text: 3, reasoning: 0 },
    }
    const model = new MockLanguageModelV4({
      modelId: "trace-test-model",
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "lookup-1",
              toolName: "lookup",
              input: '{"account":"42"}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Your order has shipped." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        },
      ],
    })
    const action: ActionRecord = {
      id: "lookup",
      projectId: context.projectId,
      agentId: "agent-a",
      slug: "lookup",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      definition: {
        id: "lookup",
        type: "client",
        name: "Lookup account",
        description: "Find an order",
        enabled: true,
        channels: ["telegram"],
        procedureOnly: false,
        eventName: "lookup",
        resultSchema: {},
        inputSchema: {
          type: "object",
          properties: { account: { type: "string" } },
          required: ["account"],
        },
      },
    }
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        conversationId: conversation.id,
        channel: "telegram",
        requestKey: "captured-model",
        message: "Where is my order?",
      },
      {
        conversationService: service,
        agent: agent(context, { model: "trace-test-model" }),
        dependencies: {
          generateText: (options) => generateText({ ...options, model }),
          resolveActions: async () => [action],
          resolveProcedures: async () => [],
          retrieveKnowledge: async () => ({
            text: "Orders ship within two days.",
            snapshotId: "knowledge:shipping-v1",
            documents: [{
              chunkId: "shipping-1", sourceName: "Shipping policy", revision: 1,
              content: "Orders ship within two days.",
              metadata: { url: "https://example.test/shipping" }, score: 0.9,
            }],
          }),
          executeAction: async () => ({
            output: {
              status: "shipped",
              authorization: "private-action-secret",
            },
          }),
        },
      }
    )
    const trace = await runTracerEffect(
      new TracerService(context.database).getTrace(result.traceId!)
    )
    const calls = trace.spans
      .filter((span) => span.kind === "llm")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(calls).toHaveLength(2)
    const firstInput = JSON.stringify(calls[0].input)
    expect(firstInput).toContain("Answer customer questions clearly.")
    expect(firstInput).toContain("Orders ship within two days.")
    expect(firstInput).toContain("My account is 42")
    expect(firstInput).toContain("How can I help?")
    expect(firstInput).toContain("Where is my order?")
    expect(JSON.stringify(calls[1].input)).toContain("shipped")
    expect(JSON.stringify(calls[0].output)).toContain("lookup-1")
    expect(JSON.stringify(calls[1].output)).toContain("Your order has shipped.")
    expect(calls.map((span) => span.status)).toEqual(["completed", "completed"])
    expect(
      calls.every((span) => span.startedAt && span.endedAt && span.parentId)
    ).toBe(true)
    expect(calls.map((span) => span.attributes["usage.input_tokens"])).toEqual([
      12, 12,
    ])
    expect(trace.spans.filter((span) => span.kind === "tool")).toHaveLength(1)
    expect(trace.attributes["datool.span.kind"]).toBe("agent")
    expect(trace.attributes["build.agent.id"]).toBe("agent-a")
    expect(trace.input).toBe("Where is my order?")
    const retrieval = trace.spans.find(span => span.name === "Knowledge retrieval")
    expect(retrieval).toMatchObject({
      status: "completed",
      input: { query: "Where is my order?", limit: 8 },
      output: {
        chunkCount: 1,
        snapshotId: "knowledge:shipping-v1",
        context: "Orders ship within two days.",
        chunks: [{
          chunkId: "shipping-1", content: "Orders ship within two days.",
          metadata: { url: "https://example.test/shipping" }, score: 0.9,
        }],
      },
    })
    expect(retrieval?.endedAt).toBeTruthy()
    expect(JSON.stringify(trace)).not.toContain("private-action-secret")
  }, 30_000)

  test("closes failed and cancelled provider calls without storing provider exception payloads", async () => {
    const { context, service } = await makeContext()
    for (const status of ["errored", "cancelled"] as const) {
      const controller = new AbortController()
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          if (status === "cancelled") controller.abort()
          throw new Error("unredacted-provider-request-body")
        },
      })
      await rejects(
        runAgentTurn(
          context,
          {
            agentId: "agent-a",
            channel: "telegram",
            requestKey: status,
            message: "Hello",
          },
          {
            conversationService: service,
            agent: agent(context, { model: "trace-test-model" }),
            signal: controller.signal,
            dependencies: {
              generateText: (options) => generateText({ ...options, model }),
            },
          }
        ),
        status === "cancelled" ? /cancelled/ : /model request failed/
      )
      const tracer = new TracerService(context.database)
      const traces = await runTracerEffect(tracer.listTraces({ limit: 1 }))
      const trace = await runTracerEffect(tracer.getTrace(traces.items[0].id))
      expect(model.doGenerateCalls).toHaveLength(1)
      expect(trace.status).toBe(status)
      const calls = trace.spans.filter((span) => span.kind === "llm")
      expect(calls).toHaveLength(1)
      expect(calls[0].status).toBe(status)
      expect(JSON.stringify(calls[0].input)).toContain("Hello")
      expect(
        trace.spans.every((span) => span.endedAt && span.status !== "running")
      ).toBe(true)
      expect(JSON.stringify(trace)).not.toContain(
        "unredacted-provider-request-body"
      )
    }
  }, 30_000)

  test("persists a guardrail response before returning it to a channel", async () => {
    const { context, service } = await makeContext()
    const result = await runAgentTurn(
      context,
      {
        agentId: "agent-a",
        channel: "telegram",
        requestKey: "telegram:guardrail-1",
        message: "I need a refund",
        metadata: {},
      },
      {
        conversationService: service,
        agent: agent(context, {
          guardrails: {
            ...agent(context).configuration.guardrails,
            blockedTopics: ["refund"],
          },
        }),
      }
    )
    expect(result.status).toBe("blocked")
    expect(result.text).toContain("can’t help")
    const messages = await service.listMessages(result.conversation.id)
    expect(messages.items.map((item) => item.role)).toEqual([
      "user",
      "assistant",
    ])
    expect(messages.items[1]?.content).toContain("can’t help")
  }, 30_000)

  test("fails closed when no model is configured instead of fabricating output", async () => {
    const { context, service } = await makeContext()
    const conversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:model-missing",
      metadata: {},
    })
    await rejects(
      runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "telegram",
          conversationId: conversation.id,
          requestKey: "telegram:model-missing-1",
          message: "Hello",
          metadata: {},
        },
        { conversationService: service, agent: agent(context) }
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "MODEL_NOT_CONFIGURED"
        )
    )
    const turns = await context.database.execute<{ status: string }>(
      /* SQL stays scoped to this fixture project through the runtime service. */
      (await import("drizzle-orm"))
        .sql`SELECT status FROM build_conversation_turns WHERE project_id = ${context.projectId} ORDER BY created_at DESC LIMIT 1`
    )
    expect(turns.rows[0]?.status).toBe("failed")
    const traces = await runTracerEffect(
      new TracerService(context.database).listTraces({ limit: 10 })
    )
    const trace = await runTracerEffect(
      new TracerService(context.database).getTrace(traces.items[0].id)
    )
    expect(trace.spans.filter((span) => span.kind === "llm")).toEqual([])
  }, 30_000)
})
