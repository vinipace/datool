import { createDatool, type RuntimePrompt, type PromptOverrides, createTracer, DatoolClient, type InvocationGroup } from "@datool/sdk"
import { DatoolSpanProcessor } from "@datool/sdk/otel"
import { withDatoolCall } from "@datool/sdk/context"
import { traceOpenAIChatFetch } from "@datool/sdk/openai"
import type { TraceDetail, Dataset, EvalRunDetail, CreateEvalRunInput, EvalRunStatus } from "@datool/sdk/contracts"
import { defineApps } from "@datool/cli"

const group: InvocationGroup = {
  type: "workflow",
  name: "consumer",
  version: "v1",
}
const tracer = createTracer({ projectId: "project" })
void tracer.workflow({ name: "consumer", group }, async () => ({ done: true }))
const client = new DatoolClient({ apiKey: "fixture", projectId: "project" })
const processor = new DatoolSpanProcessor({
  pricing: { autoRefresh: false },
  apiKey: "fixture",
  projectId: "project",
})
withDatoolCall({ connectionId: "app", callId: "call" }, () => undefined)
defineApps({
  apps: [
    {
      id: "app",
      name: "App",
      type: "workflow",
      inputSchema: {},
      outputSchema: {},
      handler: (input: { value: string }) => input,
    },
    {
      id: "agent",
      name: "Agent",
      type: "agent",
      inputSchema: {
        type: "object",
        properties: { messages: { type: "array" } },
      },
      outputSchema: { type: "string" },
      handler: (messages: { role: string; content: string }[]) =>
        messages.at(-1)?.content ?? "",
    },
  ],
})
type ApiTypes = [TraceDetail, Dataset, EvalRunDetail]
export type { ApiTypes }
void [client, processor, traceOpenAIChatFetch]

const otelTracer = createTracer({ transport: "otel", version: () => "v1" })
void otelTracer.workflow({ name: "typed-workflow" }, () =>
  otelTracer.agent({ name: "typed-agent" }, async () => new Date())
)
const stream = otelTracer.agentStream(
  { name: "typed-stream" },
  async function* () {
    yield "chunk"
  }
)
void stream.return()

async function consumeStream() {
  for await (const chunk of otelTracer.agentStream(
    { name: "inferred-stream" },
    async function* () {
      yield "chunk"
    }
  )) {
    const text: string = chunk
    void text
  }
}
void consumeStream

const runtime = createDatool({ apiKey: "fixture", promptCache: { latestTtlMs: 0 } })
const overrides: PromptOverrides = { brand: { version: 2, model: "provider/model" } }
async function consumePrompt(): Promise<RuntimePrompt> {
  return runtime.prompts.withScope(overrides, async () => {
    runtime.prompts.override("brand", { version: 1 })
    const prompt = await runtime.prompts.get("brand")
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = prompt.render({ name: "Ada" })
    void messages
    runtime.prompts.reset("brand")
    return prompt
  })
}
void consumePrompt

const nextEvaluation: CreateEvalRunInput = {
  parentRunId: "previous-run",
  useRecordedVersions: true,
  promptOverrides: { brand: { model: "provider/model" } },
}
const cancelledEvaluation: EvalRunStatus = "cancelled"
function inspectEvaluation(run: EvalRunDetail) {
  const recordedJudges: Record<string, string> | undefined = run.evaluatorVersionIds
  const stalled: boolean | undefined = run.execution?.stalled
  const stage: string | undefined = run.rows?.[0]?.stage
  const failure: string | null | undefined = run.rows?.[0]?.executionError
  return { recordedJudges, stalled, stage, failure }
}
void [nextEvaluation, cancelledEvaluation, inspectEvaluation]
