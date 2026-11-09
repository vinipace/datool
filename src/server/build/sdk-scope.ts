import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type { AgentSandboxConfiguration } from "@/src/lib/build/sandbox"
import type { SdkScope } from "@/src/lib/build/react-sdk"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "./context"
import { getAgent } from "./agents"
import { getChannelConnection } from "./channels/service"
import { ConversationService } from "./conversations"

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const sdkScopeKey = (scope: SdkScope) =>
  hash([scope.connectionId, scope.userId, scope.drive ?? null])
const denied = () =>
  new TracerError("NOT_FOUND", "This SDK conversation is not available.")

export async function sdkConnection(
  context: BuildContext,
  connectionId: string
) {
  await assertBuildProject(context)
  const { connection } = await getChannelConnection(context, connectionId)
  if (connection.channel !== "api" || connection.status !== "connected")
    throw new TracerError(
      "VALIDATION_ERROR",
      "Connect the React SDK channel before using it."
    )
  const agent = await getAgent(context, connection.agentId)
  const config = agent.appliedConfiguration ?? agent.configuration
  if (
    !config.channelAllowlist.includes("api") ||
    config.channelOverrides.api?.enabled === false
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "React SDK is disabled for this agent."
    )
  return { connection, agent, config }
}

/** Logical names are private to this connection and provider, never host paths. */
export async function resolveSdkDrive(
  context: BuildContext,
  scope: SdkScope,
  config: AgentSandboxConfiguration
) {
  if (!scope.drive) return null
  if (!config.enabled)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Enable Sandbox on this agent to use a drive."
    )
  const digest = hash([
    "sdk-drive-v1",
    context.projectId,
    scope.connectionId,
    config.provider,
    scope.drive,
  ])
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  await context.database
    .execute(sql`INSERT INTO build_drives(id,project_id,name,description,provider)
    VALUES(${id}::uuid,${context.projectId},${scope.drive},'React SDK application drive',${config.provider})
    ON CONFLICT(id) DO NOTHING`)
  return id
}

export async function createSdkSession(
  context: BuildContext,
  scope: SdkScope,
  threadId = "default"
) {
  const { connection, config } = await sdkConnection(
    context,
    scope.connectionId
  )
  const driveId = await resolveSdkDrive(context, scope, config.sandbox)
  const key = sdkScopeKey(scope)
  const service = new ConversationService(context)
  const conversation = await service.getOrCreate({
    agentId: connection.agentId,
    channel: "api",
    externalConversationId: `sdk:${hash([key, threadId])}`,
    metadata: { connectionId: connection.id, source: "react_sdk" },
  })
  // The binding is immutable. Only this authenticated service can create it.
  await context.database
    .execute(sql`INSERT INTO build_sdk_sessions(project_id,conversation_id,connection_id,scope_key,drive_id)
    VALUES(${context.projectId},${conversation.id},${connection.id}::uuid,${key},${driveId}::uuid)
    ON CONFLICT(project_id,conversation_id) DO NOTHING`)
  await requireSdkSession(context, scope, conversation.id)
  return { conversationId: conversation.id }
}

export async function requireSdkSession(
  context: BuildContext,
  scope: SdkScope,
  conversationId: string
) {
  const loaded = await sdkConnection(context, scope.connectionId)
  const result = await context.database.execute<{
    drive_id: string | null
  }>(sql`
    SELECT s.drive_id FROM build_sdk_sessions s JOIN build_conversations c ON c.project_id=s.project_id AND c.id=s.conversation_id
    WHERE s.project_id=${context.projectId} AND s.conversation_id=${conversationId}
      AND s.connection_id=${scope.connectionId}::uuid AND s.scope_key=${sdkScopeKey(scope)}
      AND c.agent_id=${loaded.connection.agentId} AND c.channel='api' AND c.status <> 'blocked'`)
  if (!result.rows[0]) throw denied()
  return { ...loaded, driveId: result.rows[0].drive_id }
}

/** Runtime reads an authenticated database binding, never caller metadata. */
export async function sdkSandboxConfiguration(
  context: BuildContext,
  conversationId: string,
  config: AgentSandboxConfiguration
) {
  const result = await context.database.execute<{
    drive_id: string | null
    status: string
  }>(sql`
    SELECT s.drive_id,c.status FROM build_sdk_sessions s JOIN build_channel_connection c ON c.id=s.connection_id AND c.project_id=s.project_id
    WHERE s.project_id=${context.projectId} AND s.conversation_id=${conversationId}`)
  const session = result.rows[0]
  if (!session) return config
  if (session.status !== "connected")
    throw new TracerError(
      "VALIDATION_ERROR",
      "The React SDK channel is paused or disconnected."
    )
  // SDK tenants never inherit static agent drives belonging to other customers.
  if (!session.drive_id) return { ...config, drives: [] }
  if (!config.enabled)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Enable Sandbox on this agent to use a drive."
    )
  return {
    ...config,
    workingDirectory: "/workspace",
    drives: [{ driveId: session.drive_id, mountPath: "/workspace" }],
  }
}

export async function scheduledSdkConversation(
  context: BuildContext,
  taskId: string,
  agentId: string
) {
  const result = await context.database.execute<{
    conversation_id: string
    agent_id: string
    status: string
  }>(sql`
    SELECT s.conversation_id,c.agent_id,c.status FROM build_sdk_tasks t
    JOIN build_sdk_sessions s ON s.project_id=t.project_id AND s.conversation_id=t.conversation_id
    JOIN build_channel_connection c ON c.id=s.connection_id AND c.project_id=s.project_id
    WHERE t.project_id=${context.projectId} AND t.task_id=${taskId}::uuid`)
  const row = result.rows[0]
  if (!row) return null
  if (row.agent_id !== agentId || row.status !== "connected") throw denied()
  return new ConversationService(context).require(row.conversation_id)
}
