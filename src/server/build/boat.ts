import { sql } from "drizzle-orm"
import type { BuildContext } from "./context"
import { BoatClient, BoatDocker } from "../sandbox/boat"
import { getSandboxProviderCredentials } from "../sandbox/providers-store"

async function clientFor(context: BuildContext) {
  const credentials = await getSandboxProviderCredentials(
    context.projectId,
    "boat",
    context.database
  )
  if (credentials.provider !== "boat")
    throw new Error("Configure Boat in project Sandbox providers first.")
  return new BoatClient(credentials.apiKey)
}

export async function boatDocker(
  context: BuildContext,
  id: string,
  create = false
) {
  const client = await clientFor(context)
  if (create)
    await context.database.execute(
      sql`INSERT INTO build_boat_sandboxes(id,project_id) VALUES(${id}::uuid,${context.projectId}) ON CONFLICT DO NOTHING`
    )
  const nativeId = await context.database.transaction(async (tx) => {
    const row = (
      await tx.execute<{ native_id: string | null; created_at: Date }>(
        sql`SELECT native_id,created_at FROM build_boat_sandboxes WHERE project_id=${context.projectId} AND id=${id}::uuid FOR UPDATE`
      )
    ).rows[0]
    if (!row) throw new Error("Boat allocation is unavailable in this project.")
    if (row.native_id) return row.native_id
    // The provider's idempotency window is 24 hours. Never mint a new VM in
    // place of an uncertain old allocation after that window has expired.
    if (
      !create ||
      Date.now() - new Date(row.created_at).getTime() > 23 * 3600_000
    )
      throw new Error(
        "Boat allocation receipt is missing. Pending files require recovery."
      )
    const allocated = await client.create(id, true)
    await tx.execute(
      sql`UPDATE build_boat_sandboxes SET native_id=${allocated} WHERE project_id=${context.projectId} AND id=${id}::uuid`
    )
    return allocated
  })
  await client.ready(nativeId, true)
  return new BoatDocker(client, nativeId)
}

export async function stopBoatSandbox(context: BuildContext, id: string) {
  const row = (
    await context.database.execute<{ native_id: string | null }>(
      sql`SELECT native_id FROM build_boat_sandboxes WHERE project_id=${context.projectId} AND id=${id}::uuid`
    )
  ).rows[0]
  if (!row) return
  if (!row.native_id)
    throw new Error(
      "Boat allocation outcome is uncertain; automatic stop remains enabled."
    )
  await (await clientFor(context)).stop(row.native_id)
  await context.database.execute(
    sql`UPDATE build_boat_sandboxes SET stopped_at=now() WHERE project_id=${context.projectId} AND id=${id}::uuid`
  )
}
