import { randomUUID, createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type { z } from "zod"
import type { sdkFileRequestSchema } from "@/src/lib/build/react-sdk"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "../context"
import { storageConnection, storageCredentials } from "./connections"
import { objectStorage } from "./objects"
import {
  drivePath,
  fileHash,
  validateManifest,
  readDriveArchive,
  writeDriveArchive,
  type Manifest,
} from "./archive"

type Drive = {
  id: string
  provider: "s3" | "gcs"
  storage_connection_id: string
  head_revision: string | null
  lease_token: string | null
  lease_until: Date | null
  sync_hydrating: boolean
  sync_pending: boolean
  sync_compute_id: string | null
  sync_compute_provider: "local" | "modal" | "datool" | "boat" | null
}
export async function loadCloudDrive(context: BuildContext, driveId: string) {
  await assertBuildProject(context)
  const rows = await context.database.execute<Drive>(
    sql`SELECT * FROM build_drives WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND provider IN ('s3','gcs')`
  )
  if (!rows.rows[0])
    throw new TracerError(
      "NOT_FOUND",
      "Object-backed drive is unavailable in this project."
    )
  return rows.rows[0]
}
async function storage(context: BuildContext, drive: Drive) {
  const connection = await storageConnection(
    context,
    drive.storage_connection_id
  )
  if (connection.config_json.provider !== drive.provider)
    throw new Error("Drive storage provider does not match its connection.")
  const prefix = connection.config_json.prefix.replace(/\/+$/, "")
  const project = createHash("sha256").update(context.projectId).digest("hex")
  const client = objectStorage(
    connection.config_json,
    storageCredentials(context, connection)
  )
  const key = (hash: string) =>
    `${prefix ? prefix + "/" : ""}projects/${project}/drives/${drive.id}/objects/${hash}`
  return {
    read: (hash: string) => client.get(key(hash)),
    write: (hash: string, bytes: Buffer) => client.put(key(hash), bytes),
    close: () => client.close(),
  }
}
export async function driveManifest(
  context: BuildContext,
  driveId: string,
  revision?: string | null
) {
  const drive = await loadCloudDrive(context, driveId)
  const id = revision === undefined ? drive.head_revision : revision
  if (!id) return { drive, manifest: [] as Manifest }
  const rows = await context.database.execute<{ manifest_json: unknown }>(
    sql`SELECT manifest_json FROM build_drive_versions WHERE project_id=${context.projectId} AND drive_id=${driveId}::uuid AND id=${id}::uuid`
  )
  if (!rows.rows[0])
    throw new TracerError("NOT_FOUND", "Drive version is unavailable.")
  return { drive, manifest: validateManifest(rows.rows[0].manifest_json) }
}
export async function assertDriveLease(
  context: BuildContext,
  driveId: string,
  token: string
) {
  const rows = await context.database.execute(
    sql`SELECT id FROM build_drives WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND lease_token=${token}::uuid AND (lease_until>now() OR sync_pending)`
  )
  if (!rows.rows.length)
    throw new Error(
      "The drive write lease was lost. Changes were not committed."
    )
}
export async function withDriveLease<T>(
  context: BuildContext,
  driveId: string,
  execute: (token: string) => Promise<T>
) {
  await loadCloudDrive(context, driveId)
  const token = randomUUID()
  const rows = await context.database.execute(
    sql`UPDATE build_drives SET lease_token=${token}::uuid,lease_until=now()+interval '5 minutes' WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND NOT sync_pending AND (lease_until IS NULL OR lease_until<=now()) RETURNING id`
  )
  if (!rows.rows.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "The drive is busy or has changes awaiting synchronization. Finish or recover its sandbox before editing files."
    )
  const timer = setInterval(() => {
    void context.database
      .execute(
        sql`UPDATE build_drives SET lease_until=now()+interval '5 minutes' WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND lease_token=${token}::uuid AND lease_until>now()`
      )
      .catch(() => undefined)
  }, 30_000)
  timer.unref()
  try {
    return await execute(token)
  } finally {
    clearInterval(timer)
    await context.database.execute(
      sql`UPDATE build_drives SET lease_token=NULL,lease_until=NULL WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND lease_token=${token}::uuid AND NOT sync_pending`
    )
  }
}
export async function commitDriveManifest(
  context: BuildContext,
  driveId: string,
  token: string,
  value: Manifest,
  files: Map<string, Buffer>
) {
  const manifest = validateManifest(value)
  const drive = await loadCloudDrive(context, driveId)
  await assertDriveLease(context, driveId, token)
  const client = await storage(context, drive)
  try {
    for (const [hash, bytes] of files) {
      await assertDriveLease(context, driveId, token)
      if (fileHash(bytes) !== hash)
        throw new Error("File integrity verification failed.")
      await client.write(hash, bytes)
    }
    const id = randomUUID()
    await context.database.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO build_drive_versions(id,project_id,drive_id,manifest_json) VALUES(${id}::uuid,${context.projectId},${driveId}::uuid,${JSON.stringify(manifest)}::jsonb)`
      )
      const changed = await tx.execute(
        sql`UPDATE build_drives SET head_revision=${id}::uuid,provisioned_at=coalesce(provisioned_at,now()),sync_pending=false,sync_hydrating=false,sync_compute_provider=NULL,sync_compute_id=NULL WHERE project_id=${context.projectId} AND id=${driveId}::uuid AND lease_token=${token}::uuid AND (lease_until>now() OR sync_pending) RETURNING id`
      )
      if (!changed.rows.length)
        throw new Error(
          "The drive write lease was lost. Changes were not committed."
        )
    })
    return id
  } finally {
    client.close()
  }
}
export async function cloudDriveFiles(
  context: BuildContext,
  driveId: string,
  request: z.infer<typeof sdkFileRequestSchema>
) {
  const path = drivePath(request.path, request.action === "list")
  return withDriveLease(context, driveId, async (token) => {
    const { drive, manifest } = await driveManifest(context, driveId)
    const item = manifest.find((entry) => entry.path === path)
    const client = await storage(context, drive)
    try {
      if (request.action === "list") {
        if (path && item?.type !== "directory")
          throw new TracerError(
            "VALIDATION_ERROR",
            "File or directory not found."
          )
        const prefix = path ? `${path}/` : ""
        const entries = manifest
          .filter(
            (entry) =>
              entry.path.startsWith(prefix) &&
              !entry.path.slice(prefix.length).includes("/")
          )
          .map((entry) => ({
            name: entry.path.slice(prefix.length),
            type: entry.type,
            size: entry.size,
          }))
        if (entries.length > 500)
          throw new TracerError(
            "VALIDATION_ERROR",
            "This directory exceeds the 500-entry listing limit."
          )
        return { entries }
      }
      if (request.action === "read") {
        if (item?.type !== "file")
          throw new TracerError(
            "VALIDATION_ERROR",
            "File or directory not found."
          )
        if (item.size > 262144)
          throw new TracerError(
            "VALIDATION_ERROR",
            "Read requires a file of at most 256 KiB. Export the drive to download larger files."
          )
        const bytes = await client.read(item.hash!)
        if (bytes.length !== item.size || fileHash(bytes) !== item.hash)
          throw new TracerError(
            "VALIDATION_ERROR",
            "Stored file integrity verification failed."
          )
        return { content: bytes.toString("base64") }
      }
      const files = new Map<string, Buffer>()
      let next = [...manifest]
      if (request.action === "delete") {
        if (!item)
          throw new TracerError(
            "VALIDATION_ERROR",
            "File or directory not found."
          )
        if (manifest.some((entry) => entry.path.startsWith(`${path}/`)))
          throw new TracerError("VALIDATION_ERROR", "Directory is not empty.")
        next = manifest.filter((entry) => entry.path !== path)
      } else {
        const parts = path.split("/")
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/")
          const found = next.find((entry) => entry.path === parent)
          if (found && found.type !== "directory")
            throw new TracerError(
              "VALIDATION_ERROR",
              "A parent path is not a directory."
            )
          if (!found)
            next.push({ path: parent, type: "directory", mode: 0o700, size: 0 })
        }
        if (request.action === "mkdir") {
          if (item?.type === "file")
            throw new TracerError(
              "VALIDATION_ERROR",
              "The path is not a directory."
            )
          if (!item)
            next.push({ path, type: "directory", mode: 0o700, size: 0 })
        } else {
          if (item?.type === "directory")
            throw new TracerError(
              "VALIDATION_ERROR",
              "The path is a directory."
            )
          const bytes = Buffer.from(request.content, "base64")
          if (bytes.length > 262144)
            throw new TracerError(
              "VALIDATION_ERROR",
              "Files must be at most 256 KiB."
            )
          const hash = fileHash(bytes)
          files.set(hash, bytes)
          next = next.filter((entry) => entry.path !== path)
          next.push({
            path,
            type: "file",
            hash,
            size: bytes.length,
            mode: item?.mode ?? 0o600,
          })
        }
      }
      await commitDriveManifest(context, driveId, token, next, files)
      if (request.action === "delete") return { deleted: true as const }
      if (request.action === "mkdir") return { created: true as const }
      return {
        written: true as const,
        size: Buffer.from(request.content, "base64").length,
      }
    } finally {
      client.close()
    }
  })
}
export async function exportCloudDrive(
  context: BuildContext,
  driveId: string,
  revision?: string
) {
  const { drive, manifest } = await driveManifest(context, driveId, revision)
  const client = await storage(context, drive)
  try {
    return await writeDriveArchive(manifest, client.read)
  } finally {
    client.close()
  }
}
export async function importCloudDrive(
  context: BuildContext,
  driveId: string,
  bytes: Buffer,
  expectedRevision: string | null
) {
  const archive = await readDriveArchive(bytes)
  return withDriveLease(context, driveId, async (token) => {
    const drive = await loadCloudDrive(context, driveId)
    if (drive.head_revision !== expectedRevision)
      throw new Error("The drive changed. Reload before restoring.")
    return commitDriveManifest(
      context,
      driveId,
      token,
      archive.manifest,
      archive.files
    )
  })
}
export async function listDriveVersions(
  context: BuildContext,
  driveId: string
) {
  const drive = await loadCloudDrive(context, driveId)
  const rows = await context.database.execute<{
    id: string
    created_at: Date
    manifest_json: Manifest
  }>(
    sql`SELECT * FROM build_drive_versions WHERE project_id=${context.projectId} AND drive_id=${driveId}::uuid ORDER BY created_at DESC,id LIMIT 100`
  )
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      files: row.manifest_json.filter((entry) => entry.type === "file").length,
      bytes: row.manifest_json.reduce((sum, entry) => sum + entry.size, 0),
      current: row.id === drive.head_revision,
    })),
  }
}
export async function restoreDriveVersion(
  context: BuildContext,
  driveId: string,
  revision: string,
  expectedRevision: string | null
) {
  // Read and verify every referenced object before replacing the current version.
  const bytes = await exportCloudDrive(context, driveId, revision)
  return {
    revision: await importCloudDrive(context, driveId, bytes, expectedRevision),
  }
}
