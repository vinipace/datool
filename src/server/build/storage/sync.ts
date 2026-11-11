import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { cloudStorage } from "@/src/lib/build/storage"
import type { AgentSandboxConfiguration } from "@/src/lib/build/sandbox"
import type { BuildContext } from "../context"
import { resolveSandboxDrives } from "../drives"
import { transferDriveArchive } from "../sandbox-runtime"
import {
  loadCloudDrive,
  exportCloudDrive,
  assertDriveLease,
  commitDriveManifest,
  driveManifest,
} from "./files"
import { readDriveArchive } from "./archive"

type Mount = Awaited<ReturnType<typeof resolveSandboxDrives>>[number]
export async function hydrateCloudDrives(
  context: BuildContext,
  config: AgentSandboxConfiguration,
  mounts: Mount[],
  token: string
) {
  for (const mount of mounts.filter((mount) => cloudStorage(mount.provider))) {
    await assertDriveLease(context, mount.id, token)
    const rows = await context.database.execute(
      sql`UPDATE build_drives SET sync_pending=true,sync_hydrating=true,sync_compute_provider=${config.provider} WHERE project_id=${context.projectId} AND id=${mount.id}::uuid AND lease_token=${token}::uuid AND lease_until>now() RETURNING id`
    )
    if (!rows.rows.length)
      throw new Error("The drive lease expired before the sandbox started.")
    await keepTransferLease(context, token, async () => {
      const archive = await exportCloudDrive(context, mount.id)
      await transferDriveArchive(context, config, mount.id, token, archive)
      const ready = await context.database.execute(
        sql`UPDATE build_drives SET sync_hydrating=false WHERE project_id=${context.projectId} AND id=${mount.id}::uuid AND lease_token=${token}::uuid AND lease_until>now() RETURNING id`
      )
      if (!ready.rows.length)
        throw new Error("The drive lease expired during hydration.")
    })
  }
}
export async function checkpointCloudDrives(
  context: BuildContext,
  config: AgentSandboxConfiguration,
  mounts: Mount[],
  token: string
) {
  for (const mount of mounts.filter((mount) => cloudStorage(mount.provider))) {
    const drive = await loadCloudDrive(context, mount.id)
    if (!drive.sync_pending) continue
    await assertDriveLease(context, mount.id, token)
    // A crash while restoring the cache must never commit a partial restore.
    if (drive.sync_hydrating) {
      await context.database.execute(
        sql`UPDATE build_drives SET sync_pending=false,sync_hydrating=false,sync_compute_provider=NULL WHERE project_id=${context.projectId} AND id=${mount.id}::uuid AND lease_token=${token}::uuid`
      )
      continue
    }
    await keepTransferLease(context, token, async () => {
      const bytes = await transferDriveArchive(context, config, mount.id, token)
      const archive = await readDriveArchive(bytes)
      const current = await driveManifest(context, mount.id)
      const existing = new Set(current.manifest.map((entry) => entry.hash))
      const files = new Map(
        [...archive.files].filter(([hash]) => !existing.has(hash))
      )
      await commitDriveManifest(
        context,
        mount.id,
        token,
        archive.manifest,
        files
      )
    })
  }
}
/** Expired native workloads have stopped before their longer drive lease expires.
 * Recover their cache before allowing another writer to replace it. Missing caches fail closed. */
export async function recoverCloudDrives(
  context: BuildContext,
  config: AgentSandboxConfiguration
) {
  const mounts = await resolveSandboxDrives(context, config)
  for (const mount of mounts.filter((mount) => cloudStorage(mount.provider))) {
    const drive = await loadCloudDrive(context, mount.id)
    if (
      !drive.sync_pending ||
      !drive.lease_token ||
      !drive.sync_compute_provider ||
      !drive.lease_until ||
      new Date(drive.lease_until).getTime() > Date.now()
    )
      continue
    const token = randomUUID()
    const claimed = await context.database.execute(
      sql`UPDATE build_drives SET lease_token=${token}::uuid,lease_until=now()+interval '5 minutes' WHERE project_id=${context.projectId} AND id=${drive.id}::uuid AND lease_token=${drive.lease_token}::uuid AND sync_pending AND lease_until<=now() RETURNING id`
    )
    if (!claimed.rows.length) continue
    await checkpointCloudDrives(
      context,
      { ...config, provider: drive.sync_compute_provider },
      [mount],
      token
    )
    await context.database.execute(
      sql`UPDATE build_drives SET lease_token=NULL,lease_until=NULL WHERE project_id=${context.projectId} AND id=${drive.id}::uuid AND lease_token=${token}::uuid AND NOT sync_pending`
    )
  }
}

/** Renew transfers without extending leases after another owner has fenced us. */
async function keepTransferLease<T>(
  context: BuildContext,
  token: string,
  execute: () => Promise<T>
) {
  const renew = () =>
    context.database.execute(
      sql`UPDATE build_drives SET lease_until=greatest(lease_until,now()+interval '5 minutes') WHERE project_id=${context.projectId} AND lease_token=${token}::uuid AND (lease_until>now() OR sync_pending)`
    )
  await renew()
  const timer = setInterval(() => {
    void renew().catch(() => undefined)
  }, 30000)
  timer.unref()
  try {
    return await execute()
  } finally {
    clearInterval(timer)
  }
}
