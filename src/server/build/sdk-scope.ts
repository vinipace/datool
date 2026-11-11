import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type { AgentSandboxConfiguration } from "@/src/lib/build/sandbox"
import type { SdkScope } from "@/src/lib/build/react-sdk"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "./context"
import { getAgent } from "./agents"
import { getChannelConnection } from "./channels/service"
import { ConversationService } from "./conversations"
import { storageConnection } from "./storage/connections"
import {
  savedSdkTaskContextSchema,
  type SavedSdkTaskContext,
} from "@/src/lib/build/sdk-context"

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

/** Preserve legacy drive IDs; new bucket-backed identities are independent of compute. */
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
  return context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([context.projectId, scope.connectionId, scope.drive])}, 0))`
    )
    return resolveLockedSdkDrive(
      { ...context, database: tx as unknown as BuildContext["database"] },
      scope,
      config
    )
  })
}
async function resolveLockedSdkDrive(
  context: BuildContext,
  scope: SdkScope,
  config: AgentSandboxConfiguration
) {
  const connection = config.sdkStorageConnectionId
    ? await storageConnection(context, config.sdkStorageConnectionId)
    : null
  if (config.provider === "boat" && !connection)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Select S3 or GCS for React SDK drive storage when using Boat."
    )
  const provider = connection?.config_json.provider ?? config.provider
  const existing = await context.database.execute<{
    id: string
    provider: string
    storage_connection_id: string | null
  }>(
    sql`SELECT id,provider,storage_connection_id FROM build_drives WHERE project_id=${context.projectId} AND sdk_context->>'connectionId'=${scope.connectionId} AND sdk_context->>'workspace'=${scope.drive}`
  )
  if (
    existing.rows.length > 1 ||
    existing.rows.some(
      (row) =>
        row.provider !== provider ||
        row.storage_connection_id !== (config.sdkStorageConnectionId ?? null)
    )
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "This workspace already has a drive in another storage location. Export and migrate its files explicitly before changing storage."
    )
  const digest = hash([
    connection ? "sdk-drive-v2" : "sdk-drive-v1",
    context.projectId,
    scope.connectionId,
    connection ? config.sdkStorageConnectionId : config.provider,
    scope.drive,
  ])
  const id =
    existing.rows[0]?.id ??
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  await context.database
    .execute(sql`INSERT INTO build_drives(id,project_id,name,description,provider,storage_connection_id,sdk_context)
    SELECT ${id}::uuid,${context.projectId},${scope.drive},'React SDK application drive',${provider},${config.sdkStorageConnectionId ?? null}::uuid,
      jsonb_build_object('agentId',c.agent_id,'connectionId',c.id,'workspace',${scope.drive}::text,'workspaceName',${scope.workspaceName ?? scope.drive}::text)
    FROM build_channel_connection c WHERE c.project_id=${context.projectId} AND c.id=${scope.connectionId}::uuid
    ON CONFLICT(id) DO UPDATE SET sdk_context=EXCLUDED.sdk_context || jsonb_build_object('workspaceName',COALESCE(${scope.workspaceName ?? null}::text,build_drives.sdk_context->>'workspaceName',EXCLUDED.sdk_context->>'workspaceName'))`)
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
  if (!session) {
    const conversation = await new ConversationService(context).require(
      conversationId
    )
    if (conversation.externalConversationId?.startsWith("sdk:")) throw denied()
    return config
  }
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
  agentId: string,
  expected?: SavedSdkTaskContext | null
) {
  const result = await context.database.execute<{
    sdk_context: SavedSdkTaskContext | null
    conversation_id: string
    agent_id: string
    status: string
    connection_id: string
    scope_key: string
    drive_id: string | null
  }>(sql`
    SELECT a.sdk_context,s.conversation_id,c.agent_id,c.status,s.connection_id,s.scope_key,s.drive_id
    FROM build_agent_schedules a
    LEFT JOIN build_sdk_tasks t ON t.project_id=a.project_id AND t.task_id=a.id
    LEFT JOIN build_sdk_sessions s ON s.project_id=t.project_id AND s.conversation_id=t.conversation_id
    LEFT JOIN build_channel_connection c ON c.id=s.connection_id AND c.project_id=s.project_id
    WHERE a.project_id=${context.projectId} AND a.id=${taskId}::uuid AND a.agent_id=${agentId}`)
  const row = result.rows[0]
  if (!row?.sdk_context) {
    if (expected || row?.conversation_id) throw denied()
    return null
  }
  const saved = savedSdkTaskContextSchema.parse(row.sdk_context)
  for (const key of [
    "conversationId",
    "connectionId",
    "scopeKey",
    "driveId",
  ] as const)
    if (expected && expected[key] !== saved[key]) throw denied()
  if (
    saved.conversationId !== row.conversation_id ||
    saved.connectionId !== row.connection_id ||
    saved.scopeKey !== row.scope_key ||
    saved.driveId !== row.drive_id
  )
    throw denied()
  if (row.agent_id !== agentId || row.status !== "connected") throw denied()
  const conversation = await new ConversationService(context).require(
    row.conversation_id
  )
  if (
    conversation.agentId !== agentId ||
    conversation.channel !== "api" ||
    conversation.status === "blocked"
  )
    throw denied()
  return conversation
}
