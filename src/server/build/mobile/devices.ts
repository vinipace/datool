import { sql } from "drizzle-orm"
import { z } from "zod"
import type { TracerDatabase } from "@/src/server/tracer/db"

export const deviceInput = z.object({
  installationId: z.string().uuid(),
  token: z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/),
}).strict()

/** Caller must authorize a live human session and project membership first. */
export async function registerInboxDevice(database: TracerDatabase, identity: {
  projectId: string; userId: string; sessionId: string
}, value: unknown) {
  const input = deviceInput.parse(value)
  await database.transaction(async tx => {
    // Serialize both token rotation and account changes on one installation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identity.projectId + input.installationId}))`)
    await tx.execute(sql`delete from inbox_mobile_devices
      where project_id=${identity.projectId} and token=${input.token} and installation_id<>${input.installationId}::uuid`)
    await tx.execute(sql`
      insert into inbox_mobile_devices(id,project_id,user_id,session_id,installation_id,token)
      values (${crypto.randomUUID()},${identity.projectId},${identity.userId},${identity.sessionId},${input.installationId}::uuid,${input.token})
      on conflict (project_id,installation_id) do update set
        token=excluded.token,user_id=excluded.user_id,session_id=excluded.session_id,updated_at=now(),
        created_at=case when inbox_mobile_devices.user_id=excluded.user_id then inbox_mobile_devices.created_at else now() end
    `)
  })
  return { enabled: true }
}
