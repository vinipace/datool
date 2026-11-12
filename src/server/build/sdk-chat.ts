import { sql } from "drizzle-orm"
import { sdkChatInputSchema } from "@/src/lib/build/react-sdk"
import type { BuildContext } from "./context"
import { ConversationService } from "./conversations"
import { createSdkSession, requireSdkSession } from "./sdk-scope"
import { runAgentTurn } from "./runtime"
import { EveExecutionPendingError } from "./eve/client"

export async function sdkChat(context: BuildContext, value: unknown) {
  const input = sdkChatInputSchema.parse(value)
  const request = input.request
  if (request.action === "session")
    return createSdkSession(context, input, request.threadId)
  const { connection } = await requireSdkSession(
    context,
    input,
    request.conversationId
  )
  if (request.action === "send") {
    try {
      const result = await runAgentTurn(context, {
        agentId: connection.agentId,
        channel: "api",
        conversationId: request.conversationId,
        requestKey: `sdk:${request.requestId}`,
        message: request.text,
        metadata: {},
      })
      return {
        conversationId: request.conversationId,
        status: result.status,
        text: result.text,
      }
    } catch (error) {
      if (error instanceof EveExecutionPendingError)
        return {
          conversationId: request.conversationId,
          status: "pending" as const,
          text: "",
        }
      throw error
    }
  }
  const service = new ConversationService(context)
  const page = await service.listMessages(request.conversationId, {
    limit: 100,
    before: request.before,
  })
  const turns = await context.database.execute<{ status: string }>(sql`
    SELECT status FROM build_conversation_turns WHERE project_id=${context.projectId} AND conversation_id=${request.conversationId}
    ORDER BY created_at DESC LIMIT 1`)
  return {
    conversationId: request.conversationId,
    messages: page.items
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          !message.metadata.internalFormReceipt &&
          !(message.role === "user" && message.metadata.scheduledTaskId)
      )
      .map((message) => ({
        id: message.id,
        role: message.role as "user" | "assistant",
        text:
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n")
              : "",
        createdAt: message.createdAt,
      })),
    nextCursor: page.nextCursor,
    pending: ["started", "running"].includes(turns.rows[0]?.status ?? ""),
    failed: ["failed", "uncertain", "cancelled"].includes(
      turns.rows[0]?.status ?? ""
    ),
  }
}
