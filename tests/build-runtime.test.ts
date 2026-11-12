import { afterEach, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { rejects } from "node:assert/strict"
import { createEveFixture, eveResponse, invokeTool } from "./helpers/eve-fixture"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction } from "@/src/server/build/definitions"
import { runAgentTurn } from "@/src/server/build/runtime"
import { ConversationService } from "@/src/server/build/conversations"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"

// Owns provider transport, model traces, and attachment privacy through real Eve.
const resources: Awaited<ReturnType<typeof createEveFixture>>[] = []
afterEach(async () => { for (const fixture of resources.splice(0)) await fixture.close() })
async function setup(model = "gpt-4.1-mini") {
  const fixture = await createEveFixture()
  resources.push(fixture)
  const agent = await createAgent(fixture.context, { name: "Support", configuration: { provider: "openai", model, instructions: "Answer customer questions clearly.", guardrails: { jevCheckEnabled: false }, channelAllowlist: ["web", "telegram", "whatsapp"] } })
  return { fixture, context: fixture.context, agent, service: new ConversationService(fixture.context) }
}
for (const [model, channel] of [["gpt-4.1-mini", "web"], ["gpt-6-luna", "telegram"]] as const)
  test(`direct OpenAI completes an Eve tool loop through Responses without storing provider state (${model})`, async () => {
    const { fixture, context, agent, service } = await setup(model)
    await saveAction(context, agent.id, { definition: { type: "client", name: "Lookup products", description: "Lookup products", eventName: "products", channels: [channel] } })
    await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
    fixture.provider((body, request) => {
      expect(request.url).toBe("/v1/responses")
      expect(request.headers.authorization).toBe("Bearer eve-project-key")
      expect(body.model).toBe(model)
      expect(body.store).toBe(false)
      return invokeTool(body, { query: "Hydrogen" }, "Products are ready.")
    })
    const result = await runAgentTurn(context, { agentId: agent.id, channel, requestKey: randomUUID(), message: "Find Hydrogen" })
    expect(fixture.requests).toHaveLength(3)
    expect(result.text).toBe("Products are ready.")
    expect((await service.listToolCalls(result.conversation.id))[0]).toMatchObject({ status: "awaiting_client", input: { query: "Hydrogen" } })
  }, 30_000)

test("captures each model request with instructions, history, knowledge, tool results and usage", async () => {
  const { fixture, context, agent, service } = await setup()
  await saveAction(context, agent.id, { definition: { type: "client", name: "Lookup account", description: "Lookup an order", eventName: "lookup", channels: ["telegram"] } })
  await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, apply: true })
  const conversation = await service.getOrCreate({ agentId: agent.id, channel: "telegram", metadata: {} })
  await service.appendMessage(conversation.id, { role: "user", content: "My account is 42", status: "completed", metadata: {} })
  await service.appendMessage(conversation.id, { role: "assistant", content: "How can I help?", status: "completed", metadata: {} })
  fixture.provider(body => invokeTool(body, { account: "42" }, "Your order has shipped."))
  const result = await runAgentTurn(context, { agentId: agent.id, channel: "telegram", conversationId: conversation.id, requestKey: randomUUID(), message: "Where is my order?" }, { dependencies: { retrieveKnowledge: async () => ({ text: "Orders ship within two days.", snapshotId: "knowledge:shipping-v1", documents: [{ chunkId: "shipping-1", content: "Orders ship within two days.", metadata: { url: "https://example.test/shipping" }, score: 0.9 }] }) } })
  const trace = await runTracerEffect(new TracerService(context.database).getTrace(result.traceId!))
  const calls = trace.spans.filter(span => span.kind === "llm").sort((a,b) => a.startedAt.localeCompare(b.startedAt))
  expect(calls).toHaveLength(3)
  for (const phrase of ["Answer customer questions clearly.", "Orders ship within two days.", "My account is 42", "How can I help?", "Where is my order?"]) expect(JSON.stringify(calls[0].input)).toContain(phrase)
  expect(JSON.stringify(calls[2].input)).toContain("client_action")
  expect(calls.every(span => span.status === "completed" && span.endedAt)).toBe(true)
  expect(trace.spans.filter(span => span.kind === "tool")).toHaveLength(1)
  expect(trace.spans.find(span => span.name === "Knowledge retrieval")).toMatchObject({ status: "completed", output: { snapshotId: "knowledge:shipping-v1", chunkCount: 1 } })
  expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 24, totalTokens: 84 })
  expect(trace.status).toBe("completed")
  expect(JSON.stringify(trace)).not.toContain("eve-project-key")
}, 30_000)

test("provider failures close model traces and never persist upstream exception payloads", async () => {
  const { fixture, context, agent, service } = await setup()
  fixture.provider(() => Response.json({ error: { message: "private-provider-diagnostic" } }, { status: 403 }))
  await rejects(runAgentTurn(context, { agentId: agent.id, channel: "web", requestKey: "failed", externalConversationId: "failed", message: "Hello" }), error => (error as { code?: string }).code === "EVE_EXECUTION_FAILED")
  const conversation = await service.getByExternalId(agent.id, "web", "failed")
  const rows = await context.database.execute<{ id: string }>(sql`SELECT id FROM build_conversation_turns WHERE project_id=${context.projectId} AND conversation_id=${conversation!.id}`)
  const turn = (await service.getTurn(rows.rows[0].id))!
  const trace = await runTracerEffect(new TracerService(context.database).getTrace(turn.traceId!))
  expect(trace.status).toBe("errored")
  expect(trace.spans.filter(span => span.kind === "llm").every(span => span.status === "errored" && span.endedAt)).toBe(true)
  expect(JSON.stringify(trace)).not.toContain("private-provider-diagnostic")
  expect(JSON.stringify(turn)).not.toContain("private-provider-diagnostic")
}, 30_000)

test("guardrail responses are durable and authoring rejects missing model configuration before paid work", async () => {
  const { fixture, context, agent, service } = await setup()
  const restricted = await updateAgent(context, agent.id, { expectedRevision: agent.currentRevision, configuration: { ...agent.configuration, guardrails: { ...agent.configuration.guardrails, blockedTopics: ["forbidden"] } } })
  const blocked = await runAgentTurn(context, { agentId: agent.id, channel: "web", requestKey: randomUUID(), message: "forbidden" })
  expect(blocked.status).toBe("blocked")
  expect((await service.listMessages(blocked.conversation.id)).items).toHaveLength(2)
  await rejects(updateAgent(context, agent.id, { expectedRevision: restricted.currentRevision, configuration: { ...restricted.configuration, model: "" } }), error => (error as { code?: string }).code === "VALIDATION_ERROR")
  expect(fixture.requests).toHaveLength(0)
}, 30_000)

test("authenticated channel images reach the provider without storing bytes in conversation history or traces", async () => {
  const { fixture, context, agent, service } = await setup()
  const data = Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3,4])
  const base64 = Buffer.from(data).toString("base64")
  fixture.provider(body => {
    expect(JSON.stringify(body.input)).toContain(`data:image/png;base64,${base64}`)
    return eveResponse(body, "A red product.")
  })
  const result = await runAgentTurn(context, { agentId: agent.id, channel: "whatsapp", requestKey: randomUUID(), message: "What is this?", metadata: { channelAttachments: [{ type: "image", fileId: "provider-id" }] } }, { trustedChannelImages: [{ data, mediaType: "image/png" }] })
  expect(result.text).toBe("A red product.")
  expect((await service.getMessagesForModel(result.conversation.id)).find(item => item.role === "user")?.content).toBe("What is this?")
  const trace = await runTracerEffect(new TracerService(context.database).getTrace(result.traceId!))
  expect(JSON.stringify(trace)).not.toContain(base64)
  expect(JSON.stringify(await service.listMessages(result.conversation.id))).not.toContain(base64)
}, 30_000)
