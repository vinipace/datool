import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createAgent } from "@/src/server/build/agents"
import { recordFeedback } from "@/src/server/build/operations/analytics"
import { runAgentTurn } from "@/src/server/build/runtime"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { createEveFixture, eveResponse } from "./helpers/eve-fixture"

test("feedback follows the rated response trace and changes replace its score without crossing conversations", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  const database = context.database
  fixture.provider(body => eveResponse(body, "Your order is on the way."))
  try {
    const agent = await createAgent(context, {
      name: "Feedback agent",
      configuration: { provider: "openai", model: "gpt-4.1-mini", guardrails: { jevCheckEnabled: false } },
    })
    const first = await runAgentTurn(
      context,
      {
        agentId: agent.id,
        channel: "web",
        requestKey: "first",
        message: "Where is my order?",
      },
      {}
    )
    const second = await runAgentTurn(
      context,
      {
        agentId: agent.id,
        channel: "web",
        conversationId: first.conversation.id,
        requestKey: "second",
        message: "When will it arrive?",
      },
      {}
    )
    expect(first.traceId).toBeTruthy()
    expect(first.message?.id).toBeTruthy()
    const input = {
      conversationId: first.conversation.id,
      question: "Where is my order?",
      // Existing preview clients send the message identity in metadata.
      metadata: { messageId: first.message!.id, traceId: second.traceId! },
    }
    await recordFeedback(context, { ...input, sentiment: "positive" })
    const tracer = new TracerService(database)
    const positive = await runTracerEffect(
      tracer.listTraceScores(first.traceId!)
    )
    expect(positive.items).toHaveLength(1)
    expect(positive.items[0]).toMatchObject({
      name: "Customer feedback",
      valueLabel: "Helpful",
    })
    expect(
      (await runTracerEffect(tracer.listTraceScores(second.traceId!))).items
    ).toHaveLength(0)

    await recordFeedback(context, {
      ...input,
      sentiment: "negative",
      reason: "Not enough detail",
    })
    const negative = await runTracerEffect(tracer.getTrace(first.traceId!))
    expect(negative.scores).toHaveLength(1)
    expect(negative.scores[0]).toMatchObject({
      name: "Customer feedback",
      valueLabel: "Not helpful",
      reasoning: "Not enough detail",
      metadata: {
        messageId: first.message!.id,
        conversationId: first.conversation.id,
      },
    })

    await rejects(
      recordFeedback(context, {
        ...input,
        conversationId: "another-conversation",
        sentiment: "positive",
      }),
      /Message is not available/
    )
    await rejects(
      recordFeedback(context, {
        ...input,
        metadata: { messageId: first.turn.inputMessageId! },
        sentiment: "positive",
      }),
      /Message is not available/
    )
    expect(
      (await runTracerEffect(tracer.getTrace(first.traceId!))).scores[0]
        ?.valueLabel
    ).toBe("Not helpful")
  } finally {
    await fixture.close()
  }
}, 30_000)
