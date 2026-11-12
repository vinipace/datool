import { beforeAll, afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"
import { createEveFixture, invokeTool, eveResponse } from "./helpers/eve-fixture"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction, saveProcedure } from "@/src/server/build/definitions"
import { runAgentTurn } from "@/src/server/build/runtime"
import { ConversationService } from "@/src/server/build/conversations"

// Owns Datool capabilities crossing Eve's actual search/invoke boundary.
let fixture: Awaited<ReturnType<typeof createEveFixture>>
beforeAll(async () => { fixture = await createEveFixture() })
afterAll(async () => { await fixture?.close() })
const configuration = { provider: "openai" as const, model: "gpt-4.1-mini", channelAllowlist: ["web"], guardrails: { jevCheckEnabled: false } }

test("client capabilities retain the issued catalog revision and replay without repeating a tool", async () => {
  const { context } = fixture
  let agent = await createAgent(context, { name: "Client capabilities", configuration })
  const action = await saveAction(context, agent.id, { definition: { type: "client", name: "Lookup", eventName: "open_ticket", channels: ["web"] } })
  agent = await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  fixture.provider(body => invokeTool(body, { subject: "Login issue" }, "The form is ready."))
  const request = { agentId: agent.id, channel: "web" as const, requestKey: randomUUID(), message: "Open a ticket" }
  const pending = await runAgentTurn(context, request)
  expect(pending.continuations[0]).toMatchObject({ type: "client_action", actionId: action.id, input: { subject: "Login issue" } })
  const count = fixture.requests.length
  const replay = await runAgentTurn(context, { ...request, conversationId: pending.conversation.id })
  expect(replay.status).toBe("replayed")
  expect(replay.continuations[0].continuationId).toBe(pending.continuations[0].continuationId)
  expect(fixture.requests.length).toBe(count)
  await saveAction(context, agent.id, { id: action.id, expectedRevision: action.revision, definition: { ...action.definition, enabled: false } })
  await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  const interaction = { agentId: agent.id, channel: "web" as const, conversationId: pending.conversation.id, requestKey: randomUUID(), message: "Opened", metadata: { widgetInteraction: { actionId: action.id, continuationId: pending.continuations[0].continuationId!, input: { subject: "Login issue" } } } }
  const resumed = await runAgentTurn(context, interaction)
  expect(resumed.turn.snapshot.agentRevision).toBe(pending.turn.snapshot.agentRevision)
  await rejects(runAgentTurn(context, { ...interaction, requestKey: randomUUID() }), error => (error as { code?: string }).code === "CONTINUATION_NOT_AVAILABLE")
  expect((await new ConversationService(context).listToolCalls(pending.conversation.id))).toHaveLength(1)
}, 30_000)

test("Eve handoff finalizes its turn, claims the human epoch and records one event across replay", async () => {
  const { context } = fixture
  let agent = await createAgent(context, { name: "Handoff", configuration })
  await saveAction(context, agent.id, { definition: { type: "handoff", name: "Lookup support", description: "Lookup a support teammate", channels: ["web"], teamId: "support", message: "A teammate will join." } })
  agent = await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  fixture.provider(body => invokeTool(body, {}, "A teammate will join."))
  const request = { agentId: agent.id, channel: "web" as const, requestKey: randomUUID(), message: "A person please" }
  const result = await runAgentTurn(context, request)
  expect(result.status).toBe("handed_off")
  expect(result.turn.status).toBe("awaiting_client")
  expect(result.conversation).toMatchObject({ ownerType: "human", ownerId: "support" })
  expect(result.conversation.ownerFence).toBeGreaterThan(result.turn.ownerFence)
  const count = fixture.requests.length
  await runAgentTurn(context, { ...request, conversationId: result.conversation.id })
  expect(fixture.requests.length).toBe(count)
  const events = await context.database.execute(sql`SELECT id FROM build_operation_events WHERE project_id=${context.projectId} AND conversation_id=${result.conversation.id} AND event_type='handoff'`)
  expect(events.rows).toHaveLength(1)
}, 30_000)

test("public intent and event metadata cannot run procedures; trusted events and keyword instructions still work", async () => {
  const { context } = fixture
  let agent = await createAgent(context, { name: "Procedure boundaries", configuration })
  await saveProcedure(context, agent.id, { definition: { name: "Event", trigger: { type: "event", value: "ticket.created" }, steps: [{ id: "done", kind: "message", content: "event handled" }] } })
  await saveProcedure(context, agent.id, { definition: { name: "Intent", trigger: { type: "intent", value: "refund" }, steps: [{ id: "done", kind: "message", content: "intent handled" }] } })
  await saveProcedure(context, agent.id, { definition: { name: "Keyword guidance", trigger: { type: "keyword", value: "guidance" }, instructions: "KEYWORD_GUIDANCE: ask for the order reference." } })
  agent = await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  fixture.provider(body => eveResponse(body, "Model handled."))
  const request = { agentId: agent.id, channel: "web" as const, requestKey: randomUUID(), message: "Hello", metadata: { event: "ticket.created", intent: "refund" } }
  expect((await runAgentTurn(context, request)).text).toBe("Model handled.")
  expect((await runAgentTurn(context, { ...request, requestKey: randomUUID() }, { trustedMetadata: { event: "ticket.created" } })).text).toBe("event handled")
  fixture.provider(body => { expect(JSON.stringify(body.input)).toContain("KEYWORD_GUIDANCE"); return eveResponse(body, "What is your order reference?") })
  expect((await runAgentTurn(context, { ...request, requestKey: randomUUID(), message: "guidance" })).text).toBe("What is your order reference?")
}, 30_000)

test("tool result context cannot exceed the daily model budget and failed paid work retains its reservation", async () => {
  const { context } = fixture
  let agent = await createAgent(context, { name: "Budget growth", configuration: { ...configuration, guardrails: { jevCheckEnabled: false, maxOutputTokens: 64, dailyBudgetUsd: 0.01 } } })
  await saveAction(context, agent.id, { definition: { type: "client", name: "Lookup catalog", description: "Lookup a large catalog", eventName: "catalog", channels: ["web"] } })
  agent = await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  const before = fixture.requests.length
  fixture.provider(body => invokeTool(body, { catalog: "Product description. ".repeat(15000) }))
  await rejects(runAgentTurn(context, { agentId: agent.id, channel: "web", requestKey: randomUUID(), message: "Catalog" }), error => (error as { code?: string }).code === "EVE_EXECUTION_FAILED")
  expect(fixture.requests.length - before).toBe(2)
  const reservations = await context.database.execute<{ status: string; estimated_usd: string }>(sql`SELECT status,estimated_usd FROM build_conversation_budget_reservations WHERE project_id=${context.projectId} AND agent_id=${agent.id}`)
  expect(reservations.rows[0].status).toBe("uncertain")
  expect(Number(reservations.rows[0].estimated_usd)).toBeGreaterThan(0)
  expect(Number(reservations.rows[0].estimated_usd)).toBeLessThanOrEqual(0.01)
}, 30_000)
