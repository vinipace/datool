import type { BuildChannel } from "@/src/lib/build/contracts"
import type { BuildContext } from "../context"
import { getRuntimeAppliedDefinitions } from "../definitions"
import type { RunAgentTurnResult, RuntimeContinuation } from "./index"

export function runtimeMessageMetadata(
  result: RunAgentTurnResult,
  continuations: RuntimeContinuation[]
) {
  const completedContinuationId =
    result.message?.metadata.completedContinuationId
  return {
    ...(continuations.length ? { continuations } : {}),
    ...(result.message?.metadata.shopifyCart
      ? { shopifyCart: result.message.metadata.shopifyCart }
      : {}),
    ...(typeof completedContinuationId === "string"
      ? { completedContinuationId }
      : {}),
  }
}

export async function pinContinuationWidgets(
  context: BuildContext,
  input: {
    channel: BuildChannel
    agentId: string
    agentRevision: unknown
    continuations: RuntimeContinuation[]
  }
) {
  const continuations = input.continuations
  if (input.channel !== "web") return continuations
  const widgetIds = [
    ...new Set(
      continuations
        .map((item) => item.widgetId)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
    ),
  ]
  if (!widgetIds.length) return continuations
  const agentRevision = Number(input.agentRevision)
  if (!Number.isInteger(agentRevision) || agentRevision < 1)
    throw new Error("The conversation turn has no pinned agent revision.")
  const definitions = await getRuntimeAppliedDefinitions(
    context,
    input.agentId,
    agentRevision
  )
  const widgets = new Map(
    definitions.widgets.map((widget) => [widget.id, widget.definition])
  )
  return continuations.map((item) => {
    if (!item.widgetId) return item
    const definition = widgets.get(item.widgetId)
    if (!definition) return item
    return {
      ...item,
      widgetDefinition: {
        name: definition.name,
        description: definition.description,
        ...(definition.code
          ? {
              code: definition.code,
              schemaCode: definition.schemaCode,
              functions: definition.functions,
            }
          : {}),
        components: definition.components,
        states: definition.states,
      },
    }
  })
}
