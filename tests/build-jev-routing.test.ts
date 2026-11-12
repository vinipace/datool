import { saveOrganizationProviderKey } from "@/src/server/model-providers/store"
import { projectProviderContext } from "@/src/server/providers/context"
import { test, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import {
  createEveFixture,
  eveResponse,
  invokeTool,
  toolOutputs,
} from "./helpers/eve-fixture"
import { saveAction } from "@/src/server/build/definitions"
import {
  actionDefinitionSchema,
  procedureDefinitionSchema,
  type ActionRecord,
  type BuildChannel,
} from "@/src/lib/build/contracts"
import { createAgent, getAgent, updateAgent } from "@/src/server/build/agents"
import { runAgentTurn } from "@/src/server/build/runtime"

// Owns Jev admission at the real agent runtime: provider calls, immutable applied
// settings, the generation/tool boundary, and persisted routing decisions.
test("Jev routing honors agent/channel switches and restricts redirect/clarify tools before generation", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  const database = context.database
  try {
    await saveOrganizationProviderKey(
      await projectProviderContext(context.projectId, database),
      "typesafe-ai",
      "project-jev-key"
    )
    let agent = await createAgent(context, {
      name: "Store assistant",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        instructions: "Help with this store's products and order status.",
        channelAllowlist: ["web", "telegram"],
        channelOverrides: {
          telegram: {
            enabled: true,
            model: "channel-model",
            jevCheckEnabled: false,
          },
        },
      },
    })
    const action: ActionRecord = {
      id: "lookup-order",
      projectId: context.projectId,
      agentId: agent.id,
      slug: "lookup-order",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      definition: actionDefinitionSchema.parse({
        id: "lookup-order",
        name: "Lookup order",
        description: "Read a store order",
        type: "client",
        eventName: "lookup-order",
        channels: ["web", "telegram"],
      }),
    }
    await saveAction(context, agent.id, {
      id: action.id,
      definition: action.definition,
    })
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      apply: true,
    })
    let route: "answer" | "redirect" | "clarify" = "answer"
    let routingCalls = 0
    let generationCalls = 0
    let actionCalls = 0
    let keywordProcedure = false
    const events: string[] = []
    const run = async (channel: BuildChannel) => {
      fixture.provider((body) => {
        if (!toolOutputs(body).length) {
          generationCalls++
          events.push("generate")
        }
        return (body.tools as unknown[] | undefined)?.length
          ? invokeTool(body, {}, "A reply.", "Lookup")
          : eveResponse(body, "A reply.")
      })
      const result = await runAgentTurn(
        context,
        {
          agentId: agent.id,
          channel,
          requestKey: randomUUID(),
          message: "Check my order",
        },
        {
          dependencies: {
            fetch: async (url, init) => {
              routingCalls++
              events.push("jev")
              expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone")
              expect(new Headers(init?.headers).get("authorization")).toBe(
                "Bearer project-jev-key"
              )
              const body = JSON.parse(String(init?.body))
              expect(JSON.stringify(body.state)).toContain(
                "Approved store reference"
              )
              return Response.json({
                model: "jev-test",
                answers: {
                  verdict: {
                    type: "choice",
                    choice: {
                      answer: "choice_0",
                      redirect: "choice_1",
                      clarify: "choice_2",
                    }[route],
                    probabilities: {
                      choice_0: 0.25,
                      choice_1: 0.25,
                      choice_2: 0.25,
                      skip: 0.25,
                    },
                  },
                },
                usage: { input_tokens: 10, output_tokens: 0 },
              })
            },
            resolveActions: async () => [action],
            resolveProcedures: async () =>
              keywordProcedure
                ? [
                    {
                      id: "order-skill",
                      projectId: context.projectId,
                      agentId: agent.id,
                      slug: "order-skill",
                      revision: 1,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                      definition: procedureDefinitionSchema.parse({
                        name: "Order skill",
                        trigger: { type: "keyword", value: "order" },
                        steps: [
                          { id: "lookup", kind: "action", actionId: action.id },
                        ],
                      }),
                    },
                  ]
                : [],
            retrieveKnowledge: async () => ({
              text: "Approved store reference",
              documents: [],
            }),
          },
        }
      )
      actionCalls += result.toolCalls.filter(
        (call) => call.actionId === action.id
      ).length
      return result
    }
    expect(agent.configuration.guardrails.jevCheckEnabled).toBe(true)
    const answered = await run("web")
    expect(answered.turn.snapshot.scopeRouting).toMatchObject({
      route: "answer",
    })
    expect(events.slice(0, 2)).toEqual(["jev", "generate"])
    expect(routingCalls).toBe(1)
    expect(actionCalls).toBe(1)
    const bypassed = await run("telegram")
    expect(bypassed.status).toBe("awaiting_client")
    expect(bypassed.turn.snapshot.scopeRouting).toBeUndefined()
    expect(routingCalls).toBe(1)
    expect(actionCalls).toBe(2)
    const draft = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        ...agent.configuration,
        guardrails: {
          ...agent.configuration.guardrails,
          jevCheckEnabled: false,
        },
      },
      apply: false,
    })
    await run("web")
    expect(routingCalls).toBe(2)
    agent = await updateAgent(context, agent.id, {
      expectedRevision: draft.currentRevision,
      apply: true,
    })
    await run("web")
    expect(routingCalls).toBe(2)
    const saved = await getAgent(context, agent.id)
    expect(saved.configuration.channelOverrides.telegram).toMatchObject({
      enabled: true,
      model: "channel-model",
      jevCheckEnabled: false,
    })
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        ...agent.configuration,
        guardrails: {
          ...agent.configuration.guardrails,
          jevCheckEnabled: true,
        },
      },
    })
    for (const restricted of ["redirect", "clarify"] as const) {
      route = restricted
      keywordProcedure = true
      const before = actionCalls
      const result = await run("web")
      expect(result.turn.snapshot.scopeRouting).toMatchObject({
        route: restricted,
      })
      expect(actionCalls).toBe(before)
    }
    expect(routingCalls).toBe(4)
    expect(generationCalls).toBe(6)
    const ledger = await database.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM build_usage_event WHERE project_id=${context.projectId} AND provider='typesafe-ai' AND model='jev-latest'`
    )
    expect(Number(ledger.rows[0].count)).toBe(4)
  } finally {
    await fixture.close()
  }
}, 60_000)
