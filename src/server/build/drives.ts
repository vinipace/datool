import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import {
  createDriveSchema,
  type AgentDrive,
  type AgentSandboxConfiguration,
} from "@/src/lib/build/sandbox"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "./context"

type DriveRow = {
  id: string
  name: string
  description: string
  provider: AgentDrive["provider"]
  created_at: Date | string
  provisioned_at: Date | string | null
}
const driveModel = (row: DriveRow): AgentDrive => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider,
  createdAt: new Date(row.created_at).toISOString(),
})

export async function listDrives(
  context: BuildContext,
  input: { after?: string; limit?: number } = {}
) {
  await assertBuildProject(context)
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200))
  const rows = await context.database.execute<DriveRow>(sql`
    SELECT * FROM build_drives WHERE project_id = ${context.projectId}
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
  await assertBuildProject(context)
  const value = createDriveSchema.parse(input)
  const rows = await context.database.execute<DriveRow>(sql`
    INSERT INTO build_drives (id, project_id, name, description, provider)
    VALUES (${randomUUID()}, ${context.projectId}, ${value.name}, ${value.description}, ${value.provider})
    RETURNING *
  `)
  return driveModel(rows.rows[0])
}

/** Resolve IDs inside the caller's project, at save time and again before execution. */
export async function resolveSandboxDrives(
  context: BuildContext,
  config: AgentSandboxConfiguration
) {
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
    if (row.provider !== config.provider)
      throw new TracerError(
        "VALIDATION_ERROR",
        "Use drives from the selected sandbox provider."
      )
    return {
      ...driveModel(row),
      mountPath: mount.mountPath,
      provisioned: row.provisioned_at !== null,
    }
  })
}
