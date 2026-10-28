import { sql } from "drizzle-orm"
import { integrationReplyText } from "../integrations/presentation"
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
    ...(result.message?.metadata.shopifyProducts
      ? { shopifyProducts: result.message.metadata.shopifyProducts }
      : {}),
    ...(result.message?.metadata.shopifyCart
      ? { shopifyCart: result.message.metadata.shopifyCart }
      : {}),
    ...(typeof completedContinuationId === "string"
      ? { completedContinuationId }
      : {}),
  }
}

/** Render the same persisted result for both browser and text-only transports. */
export function runtimeChannelMessage(
  result: RunAgentTurnResult,
  continuations: RuntimeContinuation[]
) {
  const metadata = runtimeMessageMetadata(result, continuations)
  if (result.conversation.channel === "web")
    return { text: result.text, metadata }
  const prompts = continuations
    .map((item) =>
      [
        item.title,
        item.message ?? item.submitLabel ?? item.eventName,
        item.confirmation &&
        item.type === "client_action" &&
        item.continuationId
          ? `Reply CONFIRM ${item.continuationId} to apply these exact changes.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean)
  return {
    text: [result.text, integrationReplyText(metadata, result.text), ...prompts]
      .filter(Boolean)
      .join("\n\n"),
    metadata,
  }
}

/** A text confirmation is only a transport for an existing server-owned capability.
 * Read the admitted message, never an LLM's output or caller-supplied metadata.
 * claimContinuation remains the atomic, one-shot authorization boundary.
 */
export async function channelConfirmation(
  context: BuildContext,
  conversationId: string,
  turnId: string
) {
  const admitted = await context.database.execute<{ text: string }>(sql`
    SELECT m.content_json->>'text' AS text
    FROM build_conversation_turns t
    JOIN build_conversations c ON c.project_id=t.project_id AND c.id=t.conversation_id
    JOIN build_channel_job j ON j.project_id=t.project_id AND t.request_key='channel:' || j.id::text
      AND j.kind='process_inbound'
    JOIN build_channel_message m ON m.project_id=j.project_id AND m.id=j.message_id
      AND m.conversation_id=c.id AND m.connection_id=j.connection_id AND m.direction='inbound'
    JOIN build_channel_connection ch ON ch.project_id=m.project_id AND ch.id=m.connection_id
      AND ch.channel=c.channel AND ch.agent_id=c.agent_id AND ch.status='connected'
    WHERE t.project_id=${context.projectId} AND t.id=${turnId}
      AND c.id=${conversationId} AND c.channel<>'web'
      AND c.metadata_json->>'connectionId'=ch.id::text
    LIMIT 1
  `)
  const match = admitted.rows[0]?.text
    ?.trim()
    .match(
      /^CONFIRM ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    )
  if (!match) return null
  const pending = await context.database.execute<{
    continuation: RuntimeContinuation
  }>(sql`
    SELECT continuation_json AS continuation FROM build_conversation_tool_calls
    WHERE project_id=${context.projectId} AND conversation_id=${conversationId}
      AND continuation_json->>'continuationId'=${match[1].toLowerCase()}
      AND continuation_json->>'type'='client_action'
      AND continuation_json->>'confirmation'='true'
    LIMIT 1
  `)
  const continuation = pending.rows[0]?.continuation
  if (!continuation?.actionId)
    throw new Error("This customer confirmation is no longer available.")
  return {
    actionId: continuation.actionId,
    continuationId: match[1].toLowerCase(),
    input: continuation.input ?? {},
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
