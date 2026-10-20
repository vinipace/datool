import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { createAgent } from "@/src/server/build/agents"
import { createBuildContext } from "@/src/server/build/context"
import { recordFeedback } from "@/src/server/build/operations/analytics"
import {
  runAgentTurn,
  type RuntimeDependencies,
} from "@/src/server/build/runtime"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

const model: RuntimeDependencies = {
  generateText: (async () => ({
    text: "Your order is on the way.",
    usage: { inputTokens: 2, outputTokens: 7, totalTokens: 9 },
  })) as unknown as NonNullable<RuntimeDependencies["generateText"]>,
}

test("feedback follows the rated response trace and changes replace its score without crossing conversations", async () => {
  const database = await createTracerFixture()
  const context = createBuildContext(database)
  try {
    const agent = await createAgent(context, {
      name: "Feedback agent",
      configuration: { model: "test-model" },
    })
    const first = await runAgentTurn(
      context,
      {
        agentId: agent.id,
        channel: "web",
        requestKey: "first",
        message: "Where is my order?",
      },
      { dependencies: model }
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
      { dependencies: model }
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
    await closeTracerFixture(database)
  }
}, 30_000)
