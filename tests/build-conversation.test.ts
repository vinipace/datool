import { afterEach, describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"

import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  ConversationBudgetExceededError,
  ConversationHumanOwnedError,
  ConversationService,
} from "@/src/server/build/conversations"
import { createAgent } from "@/src/server/build/agents"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const resources: Array<{ database: TracerDatabase; target: IsolatedPostgres }> = []

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeService() {
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
  return {
    service: new ConversationService({ database, projectId: target.projectId }),
    projectId: target.projectId,
  }
}

describe("Build conversation ledger", () => {
  test("lists all chats with independent conversation status, search and cursor pagination", async () => {
    const { service } = await makeService()
    const ordinary = await service.getOrCreate({
      agentId: "agent-a",
      channel: "web",
      metadata: {},
    })
    const escalated = await service.getOrCreate({
      agentId: "agent-a",
      channel: "api",
      metadata: {},
    })
    await service.appendMessage(ordinary.id, {
      role: "user",
      content: "Opening hours",
      status: "completed",
      metadata: {},
    })
    await service.appendMessage(escalated.id, {
      role: "user",
      content: "Refund investigation",
      status: "completed",
      metadata: {},
    })
    await service.claim(escalated.id, {
      type: "human",
      id: "support",
      reason: "Investigate refund",
    })
    const all = await service.list()
    expect(all.items).toHaveLength(2)
    expect(all.items.find((item) => item.id === ordinary.id)).toMatchObject({
      subject: "Opening hours",
      status: "active",
      ticketId: null,
    })
    expect(all.items.find((item) => item.id === escalated.id)).toMatchObject({
      status: "handed_off",
      ticketStatus: "open",
    })
    expect(
      all.items.find((item) => item.id === escalated.id)?.ticketId
    ).toBeTruthy()
    expect(
      (
        await service.list({ search: "Refund", status: "handed_off" })
      ).items.map((item) => item.id)
    ).toEqual([escalated.id])
    expect(
      (await service.list({ channel: "web" })).items.map((item) => item.id)
    ).toEqual([ordinary.id])
    const first = await service.list({ limit: 1 })
    const second = await service.list({ limit: 1, cursor: first.nextCursor })
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      all.items.map((item) => item.id)
    )
    expect(second.nextCursor).toBeNull()

    const { service: otherProject } = await makeService()
    expect((await otherProject.list({ search: "Refund" })).items).toEqual([])
  })

  test("deduplicates external conversations and replays completed request keys", async () => {
    const { service } = await makeService()
    const conversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:chat-1",
      metadata: { source: "test" },
    })
    const sameConversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:chat-1",
      metadata: {},
    })
    expect(sameConversation.id).toBe(conversation.id)

    const admission = await service.startTurn(conversation.id, {
      requestKey: "telegram:update-1",
      input: "Hello",
      metadata: {},
      snapshot: { revision: 3 },
    })
    expect(admission.kind).toBe("created")
    if (admission.kind !== "created") return
    const output = await service.appendMessage(conversation.id, {
      role: "assistant",
      content: "Hello back",
      turnId: admission.turn.id,
      status: "completed",
      metadata: {},
    })
    await service.finishTurn({
      turnId: admission.turn.id,
      ownerFence: admission.turn.ownerFence,
      status: "completed",
      outputMessageId: output.id,
      usage: { totalTokens: 3 },
    })

    const replay = await service.startTurn(conversation.id, {
      requestKey: "telegram:update-1",
      input: "Hello",
      metadata: {},
      snapshot: { revision: 99 },
    })
    expect(replay.kind).toBe("replay")
    if (replay.kind === "replay") {
      expect(replay.turn.snapshot).toEqual({ revision: 3 })
      expect(replay.outputMessage?.content).toBe("Hello back")
    }
  }, 30_000)

  test("ownership fencing prevents AI turns during human handoff", async () => {
    const { service } = await makeService()
    const conversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:chat-2",
      metadata: {},
    })
    const human = await service.claim(conversation.id, {
      type: "human",
      id: "support-user",
      reason: "Customer requested a person",
    })
    expect(human.ownerType).toBe("human")
    expect(human.ownerFence).toBe(conversation.ownerFence + 1)
    await rejects(
      service.startTurn(conversation.id, {
        requestKey: "telegram:update-2",
        input: "Are you there?",
        metadata: {},
        snapshot: {},
      }),
      ConversationHumanOwnedError
    )

    const ai = await service.releaseToAi(conversation.id)
    expect(ai.ownerType).toBe("ai")
    expect(ai.ownerFence).toBe(human.ownerFence + 1)
    const admission = await service.startTurn(conversation.id, {
      requestKey: "telegram:update-2",
      input: "Are you there?",
      metadata: {},
      snapshot: {},
    })
    expect(admission.kind).toBe("created")
    if (admission.kind !== "created") return
    const stale = await service.claim(admission.conversation.id, {
      type: "human",
      id: "support-user",
      reason: "Support took over while the AI worker was running",
    })
    expect(
      await service.markUncertain(
        admission.turn.id,
        { kind: "stale-worker" },
        admission.turn.ownerFence
      )
    ).toBeNull()
    expect((await service.getTurn(admission.turn.id))?.status).toBe("uncertain")
    expect(stale.ownerFence).toBe(admission.turn.ownerFence + 1)
  }, 30_000)

  test("serializes simultaneous channel deliveries behind one active turn", async () => {
    const { service } = await makeService()
    const conversation = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:chat-concurrent",
      metadata: {},
    })
    const admissions = await Promise.all([
      service.startTurn(conversation.id, {
        requestKey: "telegram:concurrent-1",
        input: "First",
        metadata: {},
        snapshot: {},
      }),
      service.startTurn(conversation.id, {
        requestKey: "telegram:concurrent-2",
        input: "Second",
        metadata: {},
        snapshot: {},
      }),
    ])
    expect(admissions.filter((item) => item.kind === "created")).toHaveLength(1)
    expect(admissions.filter((item) => item.kind === "busy")).toHaveLength(1)
  }, 30_000)

  test("serializes daily budget reservations across conversations", async () => {
    const { service } = await makeService()
    const first = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:budget-1",
      metadata: {},
    })
    const second = await service.getOrCreate({
      agentId: "agent-a",
      channel: "telegram",
      externalConversationId: "telegram:budget-2",
      metadata: {},
    })
    const firstTurn = await service.startTurn(first.id, {
      requestKey: "telegram:budget-turn-1",
      input: "First",
      metadata: {},
      snapshot: {},
    })
    const secondTurn = await service.startTurn(second.id, {
      requestKey: "telegram:budget-turn-2",
      input: "Second",
      metadata: {},
      snapshot: {},
    })
    if (firstTurn.kind !== "created" || secondTurn.kind !== "created") return
    const results = await Promise.allSettled([
      service.reserveBudget({
        agentId: "agent-a",
        conversationId: first.id,
        turnId: firstTurn.turn.id,
        ownerFence: firstTurn.turn.ownerFence,
        estimatedUsd: 0.75,
        dailyLimitUsd: 1,
      }),
      service.reserveBudget({
        agentId: "agent-a",
        conversationId: second.id,
        turnId: secondTurn.turn.id,
        ownerFence: secondTurn.turn.ownerFence,
        estimatedUsd: 0.75,
        dailyLimitUsd: 1,
      }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConversationBudgetExceededError
    )
  }, 30_000)
})
