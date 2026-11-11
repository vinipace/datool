import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import {
  createDriveSchema,
  type AgentDrive,
  type AgentSandboxConfiguration,
} from "@/src/lib/build/sandbox"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "./context"
import { cloudStorage } from "@/src/lib/build/storage"
import { storageConnection } from "./storage/connections"

type DriveRow = {
  id: string
  name: string
  description: string
  provider: AgentDrive["provider"]
  created_at: Date | string
  provisioned_at: Date | string | null
  sdk_context: AgentDrive["sdkContext"]
  storage_connection_id: string | null
  head_revision: string | null
  sync_pending: boolean
}
const driveModel = (row: DriveRow): AgentDrive => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider,
  createdAt: new Date(row.created_at).toISOString(),
  sdkContext: row.sdk_context ?? null,
  ...(row.storage_connection_id
    ? { storageConnectionId: row.storage_connection_id }
    : {}),
  revision: row.head_revision ?? null,
  syncPending: row.sync_pending ?? false,
})

export async function listDrives(
  context: BuildContext,
  input: { after?: string; limit?: number; agentId?: string } = {}
) {
  await assertBuildProject(context)
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200))
  const rows = await context.database.execute<DriveRow>(sql`
    SELECT * FROM build_drives WHERE project_id = ${context.projectId}
    ${input.agentId ? sql`AND (sdk_context IS NULL OR sdk_context->>'agentId'=${input.agentId})` : sql``}
    ${input.after ? sql`AND id > ${input.after}::uuid` : sql``}
    ORDER BY id LIMIT ${limit + 1}
  `)
  return {
    items: rows.rows.slice(0, limit).map(driveModel),
    nextCursor: rows.rows.length > limit ? rows.rows[limit - 1].id : null,
  }
}

export async function createDrive(
  context: BuildContext,
  input: unknown
): Promise<AgentDrive> {
  const { organizationId } = await assertBuildProject(context)
  const value = createDriveSchema.parse(input)
  if (cloudStorage(value.provider)) {
    if (!value.storageConnectionId)
      throw new TracerError(
        "VALIDATION_ERROR",
        "Select a storage connection for this drive."
      )
    const connection = await storageConnection(
      context,
      value.storageConnectionId
    )
    if (connection.config_json.provider !== value.provider)
      throw new TracerError(
        "VALIDATION_ERROR",
        "The storage connection uses a different provider."
      )
  } else if (value.storageConnectionId)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Local and Modal volumes do not use bucket connections."
    )
  const rows = await context.database.execute<DriveRow>(sql`
    INSERT INTO build_drives (id, project_id, organization_id, name, description, provider, storage_connection_id)
    VALUES (${randomUUID()}, ${context.projectId}, ${organizationId}, ${value.name}, ${value.description}, ${value.provider},${value.storageConnectionId ?? null}::uuid)
    RETURNING *
  `)
  return driveModel(rows.rows[0])
}

/** Resolve IDs inside the caller's project, at save time and again before execution. */
export async function resolveSandboxDrives(
  context: BuildContext,
  config: AgentSandboxConfiguration
) {
  if (config.sdkStorageConnectionId)
    await storageConnection(context, config.sdkStorageConnectionId)
  if (!config.drives.length) return []
  const ids = sql.join(
    config.drives.map((mount) => sql`${mount.driveId}::uuid`),
    sql`, `
  )
  const rows = await context.database.execute<DriveRow>(sql`
    SELECT * FROM build_drives WHERE project_id = ${context.projectId} AND id IN (${ids})
  `)
  return config.drives.map((mount) => {
    const row = rows.rows.find((row) => row.id === mount.driveId)
    if (!row)
      throw new TracerError(
        "VALIDATION_ERROR",
        "A mounted drive is unavailable in this project."
      )
    if (!cloudStorage(row.provider) && row.provider !== config.provider)
      throw new TracerError(
        "VALIDATION_ERROR",
        "Local and Modal volumes must match the selected sandbox provider. Object-backed drives can use any sandbox provider."
      )
    return {
      ...driveModel(row),
      mountPath: mount.mountPath,
      provisioned: row.provisioned_at !== null,
    }
  })
}
