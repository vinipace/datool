import { afterAll, beforeAll, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { createEveFixture, eveResponse } from "./helpers/eve-fixture"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction, saveProcedure } from "@/src/server/build/definitions"
import { runAgentTurn } from "@/src/server/build/runtime"
import { ConversationService } from "@/src/server/build/conversations"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"

// Owns the engine boundary: actual Eve server, PostgreSQL workflow checkpoints,
// vendor HTTP protocol, DB-authored configuration, and real process termination.
let fixture: Awaited<ReturnType<typeof createEveFixture>>
let context: Awaited<ReturnType<typeof createEveFixture>>["context"]
let requests: Array<Record<string, unknown>>
let pauseAfterTool = false
let paused: (() => void) | null = null
let release: (() => void) | null = null
beforeAll(async () => {
  fixture = await createEveFixture()
  context = fixture.context
  requests = fixture.requests
  fixture.provider(async (body, request) => {
    expect(request.headers.authorization).toBe("Bearer eve-project-key")
    expect(body.store).toBe(false)
    const input = JSON.stringify(body.input)
    const tools = (body.tools ?? []) as Array<{ name: string }>
    if (input.includes("USE_LOOKUP")) {
      const outputs = (
        body.input as Array<{ type: string; output?: unknown }>
      ).filter((item) => item.type === "function_call_output")
      if (!outputs.length && tools.some((item) => item.name === "eve__search"))
        return eveResponse(body, "", {
          name: "eve__search",
          input: { query: "Lookup" },
        })
      const found = outputs.flatMap((item) => {
        try {
          const parsed =
            typeof item.output === "string"
              ? JSON.parse(item.output)
              : item.output
          return parsed?.results ?? []
        } catch {
          return []
        }
      }) as Array<{ tool?: string }>
      const discovered = found.find((item) =>
        item.tool?.startsWith("action_")
      )?.tool
      const finished = outputs.some((item) =>
        /client_action|approval_required/.test(JSON.stringify(item.output))
      )
      const procedure = found.find((item) =>
        item.tool?.startsWith("procedure_")
      )?.tool
      const loaded = outputs.some((item) =>
        JSON.stringify(item.output).includes("SKILL_INSTRUCTIONS")
      )
      if (!finished && !discovered && procedure && !loaded)
        return eveResponse(body, "", {
          name: "eve__tool",
          input: { name: procedure, input: {} },
        })
      if (!finished && !discovered && loaded)
        return eveResponse(body, "", {
          name: "eve__search",
          input: { query: "Lookup" },
        })
      if (
        !finished &&
        discovered &&
        tools.some((item) => item.name === "eve__tool")
      )
        return eveResponse(body, "", {
          name: "eve__tool",
          input: { name: discovered, input: { query: "stored" } },
        })
      if (pauseAfterTool) {
        pauseAfterTool = false
        paused?.()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return eveResponse(body, "The lookup is ready.")
    }
    return eveResponse(
      body,
      input.includes("REVISION_TWO")
        ? "Revision two."
        : input.includes("SECOND_AGENT")
          ? "Second agent."
          : "Revision one."
    )
  })
})
afterAll(async () => {
  release?.()
  await fixture?.close()
})

const config = {
  provider: "openai" as const,
  model: "gpt-4.1-mini",
  instructions: "REVISION_ONE",
  channelAllowlist: ["web", "telegram"] as const,
  guardrails: { jevCheckEnabled: false },
}
function run(
  agentId: string,
  message = "Hello",
  channel: "web" | "telegram" = "web"
) {
  return runAgentTurn(context, {
    agentId,
    channel,
    requestKey: randomUUID(),
    message,
  })
}

test("Eve runs database-defined agents and keeps drafts separate from published revisions without rebuilding", async () => {
  let agent = await createAgent(context, {
    name: "First",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  expect((await run(agent.id)).text).toBe("Revision one.")
  const other = await createAgent(context, {
    name: "Second",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
      instructions: "SECOND_AGENT",
    },
  })
  expect((await run(other.id)).text).toBe("Second agent.")
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    configuration: { ...agent.configuration, instructions: "REVISION_TWO" },
    apply: false,
  })
  const draft = await run(agent.id)
  expect(draft.text).toBe("Revision one.")
  expect(draft.turn.snapshot.agentRevision).toBe(1)
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    apply: true,
  })
  const published = await run(agent.id)
  expect(published.text).toBe("Revision two.")
  expect(published.message?.metadata.engine).toBe("eve")
  expect(published.message?.metadata.revision).toBe(agent.appliedRevision)
}, 60_000)

test("guardrails deny model access before execution and enforce per-channel configuration", async () => {
  const agent = await createAgent(context, {
    name: "Restricted",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
      channelOverrides: { telegram: { enabled: false } },
      guardrails: { jevCheckEnabled: false, blockedTopics: ["forbidden"] },
    },
  })
  const count = requests.length
  expect((await run(agent.id, "forbidden")).status).toBe("blocked")
  expect((await run(agent.id, "Hello", "telegram")).status).toBe("blocked")
  expect(requests.length).toBe(count)
  const service = new ConversationService(context)
  const conversation = await service.getOrCreate({
    agentId: agent.id,
    channel: "web",
    metadata: {},
  })
  await service.claim(conversation.id, {
    type: "human",
    id: "operator",
    reason: "Test human takeover",
  })
  await rejects(
    runAgentTurn(context, {
      agentId: agent.id,
      channel: "web",
      conversationId: conversation.id,
      requestKey: randomUUID(),
      message: "Hello",
    })
  )
  expect(requests.length).toBe(count)
}, 60_000)

test("Jev and approval guardrails apply to the real Eve tool boundary per channel", async () => {
  await context.database.execute(
    sql`INSERT INTO project_model_provider(project_id,provider,encrypted_api_key) VALUES(${context.projectId},'typesafe-ai',${encryptProviderKey("jev-project-key", context.projectId, "typesafe-ai")})`
  )
  let agent = await createAgent(context, {
    name: "Jev",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
      guardrails: { jevCheckEnabled: true },
      channelOverrides: { telegram: { enabled: true, jevCheckEnabled: false } },
    },
  })
  await saveAction(context, agent.id, {
    id: "lookup_jev",
    slug: "lookup",
    definition: {
      type: "client",
      name: "Lookup",
      description: "Lookup stored records",
      eventName: "lookup",
      channels: ["web", "telegram"],
    },
  })
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    apply: true,
  })
  let jevCalls = 0
  const dependencies = {
    fetch: async () => {
      jevCalls++
      return Response.json({
        model: "jev",
        answers: {
          verdict: {
            type: "choice",
            choice: "choice_1",
            probabilities: {
              choice_0: 0.1,
              choice_1: 0.8,
              choice_2: 0.05,
              skip: 0.05,
            },
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      })
    },
  }
  const routed = await runAgentTurn(
    context,
    {
      agentId: agent.id,
      channel: "web",
      requestKey: randomUUID(),
      message: "USE_LOOKUP",
    },
    { dependencies }
  )
  expect(routed.turn.snapshot.scopeRouting).toMatchObject({ route: "redirect" })
  expect(routed.toolCalls).toHaveLength(0)
  expect(jevCalls).toBe(1)
  const bypassed = await runAgentTurn(
    context,
    {
      agentId: agent.id,
      channel: "telegram",
      requestKey: randomUUID(),
      message: "USE_LOOKUP",
    },
    { dependencies }
  )
  expect(
    bypassed.toolCalls.some((call) => call.actionId === "lookup_jev")
  ).toBe(true)
  expect(jevCalls).toBe(1)
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    configuration: {
      ...agent.configuration,
      guardrails: {
        ...agent.configuration.guardrails,
        jevCheckEnabled: false,
        requireHumanForActions: true,
      },
    },
  })
  const approval = await runAgentTurn(
    context,
    {
      agentId: agent.id,
      channel: "web",
      requestKey: randomUUID(),
      message: "USE_LOOKUP",
    },
    { dependencies }
  )
  expect(approval.continuations[0].type).toBe("approval_required")
  expect(jevCalls).toBe(1)
}, 60_000)

test("tool search loads database skills before exposing their private actions", async () => {
  let agent = await createAgent(context, {
    name: "Skills",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  const action = await saveAction(context, agent.id, {
    slug: "private-lookup",
    definition: {
      type: "client",
      name: "Lookup",
      description: "Lookup private records",
      eventName: "lookup",
      procedureOnly: true,
      channels: ["web"],
    },
  })
  await saveProcedure(context, agent.id, {
    slug: "lookup-skill",
    definition: {
      name: "Lookup skill",
      description: "Lookup records",
      trigger: { type: "intent", value: "Lookup records" },
      instructions: `SKILL_INSTRUCTIONS: use [@Lookup](action:${action.slug}).`,
      actionRefs: [action.id],
    },
  })
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    apply: true,
  })
  const result = await run(agent.id, "USE_LOOKUP USE_SKILL")
  expect(result.toolCalls.some((call) => call.actionId === action.id)).toBe(
    true
  )
  expect(result.continuations[0].type).toBe("client_action")
}, 60_000)

test("budget admission and transport identity fail before paid work", async () => {
  const agent = await createAgent(context, {
    name: "Budget",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
      guardrails: { jevCheckEnabled: false, dailyBudgetUsd: 0 },
    },
  })
  const count = requests.length
  expect((await run(agent.id)).status).toBe("blocked")
  expect(requests.length).toBe(count)
  const unauthorized = await fetch(
    `http://127.0.0.1:${fixture.port}/datool/executions/${context.projectId}/missing/execute`,
    { method: "POST" }
  )
  expect(unauthorized.status).toBe(401)
  const crossProject = await fetch(
    `http://127.0.0.1:${fixture.port}/datool/executions/another-project/missing/execute`,
    { method: "POST", headers: { authorization: `Bearer ${fixture.secret}` } }
  )
  expect(crossProject.status).toBe(404)
}, 60_000)

test("Eve recovers after a hard process stop and retains completed tool work", async () => {
  let agent = await createAgent(context, {
    name: "Recovery",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  await saveAction(context, agent.id, {
    id: "lookup",
    slug: "lookup",
    definition: {
      id: "lookup",
      type: "client",
      name: "Lookup",
      description: "Lookup stored records",
      eventName: "lookup",
      channels: ["web"],
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  })
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    apply: true,
  })
  const reachedCheckpoint = new Promise<void>((resolve) => {
    paused = resolve
  })
  pauseAfterTool = true
  const pinnedRevision = agent.appliedRevision
  const result = run(agent.id, "USE_LOOKUP")
  await Promise.race([
    reachedCheckpoint,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error("The model did not reach the post-tool checkpoint.")
          ),
        30_000
      )
    ),
  ])
  await fixture.stop()
  agent = await updateAgent(context, agent.id, {
    expectedRevision: agent.currentRevision,
    configuration: { ...agent.configuration, instructions: "REVISION_TWO" },
  })
  release?.()
  await fixture.start()
  const completed = await result
  expect(completed.text).toBe("The lookup is ready.")
  expect(
    completed.toolCalls.filter((item) => item.actionId === "lookup")
  ).toHaveLength(1)
  expect(completed.continuations).toHaveLength(1)
  expect(completed.continuations[0].type).toBe("client_action")
  expect(completed.turn.status).toBe("awaiting_client")
  expect(completed.message?.metadata.revision).toBe(pinnedRevision)
  expect((await run(agent.id)).text).toBe("Revision two.")
}, 90_000)

test("an offline runtime acknowledges a durable pending turn promptly and recovers it once", async () => {
  const { reconcileEveExecutions } =
    await import("@/src/server/build/eve/recovery")
  const agent = await createAgent(context, {
    name: "Offline runtime",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  const service = new ConversationService(context)
  const conversation = await service.getOrCreate({
    agentId: agent.id,
    channel: "web",
    metadata: {},
  })
  const requestKey = randomUUID()
  const count = requests.length
  await fixture.stop()
  const controller = new AbortController()
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("The unavailable runtime held the request too long.")
      ),
    8_000
  )
  try {
    const started = performance.now()
    await rejects(
      runAgentTurn(
        context,
        {
          agentId: agent.id,
          channel: "web",
          conversationId: conversation.id,
          requestKey,
          message: "Hello",
        },
        { signal: controller.signal }
      ),
      (error) => {
        expect(error).toMatchObject({
          code: "EXECUTION_PENDING",
          details: {
            reason: "EXECUTION_PENDING",
            conversationId: conversation.id,
          },
        })
        expect(performance.now() - started).toBeLessThan(7_500)
        return true
      }
    )
    expect(requests.length).toBe(count)
    expect(
      (await service.listMessages(conversation.id)).items.map(
        (message) => message.role
      )
    ).toEqual(["user"])
  } finally {
    clearTimeout(timer)
    await fixture.start()
  }
  const completed = await runAgentTurn(context, {
    agentId: agent.id,
    channel: "web",
    conversationId: conversation.id,
    requestKey,
    message: "Hello",
  })
  expect(completed.text).toBe("Revision one.")
  await reconcileEveExecutions(context, { staleSeconds: 0 })
  expect(
    (await service.listMessages(conversation.id)).items.map(
      (message) => message.role
    )
  ).toEqual(["user", "assistant"])
  expect(requests.length).toBe(count + 1)
}, 30_000)

test("the recovery worker dispatches orphaned plans and repairs a missed completion hook", async () => {
  const { createEveExecution } = await import("@/src/server/build/eve/store")
  const { reconcileEveExecutions } =
    await import("@/src/server/build/eve/recovery")
  const agent = await createAgent(context, {
    name: "Orphaned caller",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  const service = new ConversationService(context)
  const conversation = await service.getOrCreate({
    agentId: agent.id,
    channel: "web",
    metadata: {},
  })
  const admitted = await service.startTurn(conversation.id, {
    requestKey: randomUUID(),
    input: "Hello",
    metadata: {},
    snapshot: { agentRevision: agent.appliedRevision },
  })
  await createEveExecution(context, {
    agentId: agent.id,
    conversationId: conversation.id,
    turnId: admitted.turn.id,
    ownerFence: admitted.turn.ownerFence,
    plan: {
      agent: {
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        revision: agent.appliedRevision,
      },
      configuration: agent.configuration,
      system: agent.configuration.instructions,
      messages: [{ role: "user", content: "Hello" }],
      inputText: "Hello",
      scopeRestricted: false,
      sandboxEnabled: false,
      initialActionRefs: [],
      integrationMetadata: {},
      formCompletion: null,
      budgetReservation: null,
      maxToolSteps: 8,
    },
  })
  // Simulate the database refusing the ordinary completion hook. Eve must retain
  // the settled result independently, rather than depend on a live HTTP caller.
  await context.database.execute(
    sql.raw(
      `CREATE FUNCTION fixture_reject_eve_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome_json IS NOT NULL THEN RAISE EXCEPTION 'fixture projection interruption'; END IF; RETURN NEW; END $$`
    )
  )
  await context.database.execute(
    sql.raw(
      `CREATE TRIGGER fixture_eve_projection BEFORE UPDATE ON build_eve_executions FOR EACH ROW EXECUTE FUNCTION fixture_reject_eve_outcome()`
    )
  )
  const count = requests.length
  try {
    await reconcileEveExecutions(context, { staleSeconds: 0 })
    const deadline = Date.now() + 10_000
    while (requests.length === count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests.length).toBe(count + 1)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await service.getTurn(admitted.turn.id))!.status).toBe("running")
  } finally {
    await context.database.execute(
      sql.raw(`DROP TRIGGER fixture_eve_projection ON build_eve_executions`)
    )
  }
  const deadline = Date.now() + 10_000
  while (
    (await service.getTurn(admitted.turn.id))!.status === "running" &&
    Date.now() < deadline
  ) {
    await reconcileEveExecutions(context, { staleSeconds: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect((await service.getTurn(admitted.turn.id))!.status).toBe("completed")
  expect(
    (await service.listMessages(conversation.id)).items.map(
      (message) => message.role
    )
  ).toEqual(["user", "assistant"])
  await reconcileEveExecutions(context, { staleSeconds: 0 })
  expect(requests.length).toBe(count + 1)
}, 30_000)

test("human takeover during a provider request fences Eve's late completion", async () => {
  const agent = await createAgent(context, {
    name: "Takeover",
    configuration: {
      ...config,
      channelAllowlist: [...config.channelAllowlist],
    },
  })
  let started: () => void
  let unblock: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  fixture.provider(async (body) => {
    started()
    await new Promise<void>((resolve) => {
      unblock = resolve
    })
    return eveResponse(body, "Late reply.")
  })
  const pending = runAgentTurn(context, {
    agentId: agent.id,
    channel: "web",
    externalConversationId: "takeover",
    requestKey: randomUUID(),
    message: "Hello",
  })
  const failed = rejects(
    pending,
    (error) => (error as { code?: string }).code === "EVE_EXECUTION_FAILED"
  )
  await waiting
  const service = new ConversationService(context)
  const conversation = await service.getByExternalId(
    agent.id,
    "web",
    "takeover"
  )
  await service.claim(conversation!.id, {
    type: "human",
    id: "operator",
    reason: "Live takeover",
  })
  unblock!()
  await failed
  expect(
    (await service.listMessages(conversation!.id)).items.filter(
      (message) => message.role === "assistant"
    )
  ).toHaveLength(0)
}, 30_000)
