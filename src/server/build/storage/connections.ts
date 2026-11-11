import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import {
  storageConfigSchema,
  storageConnectionInputSchema,
  type StorageConnection,
} from "@/src/lib/build/storage"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { TracerError } from "@/src/server/tracer/errors"
import { type BuildContext } from "../context"
import { objectStorage } from "./objects"
import {
  providerContext,
  organizationCredentialScope,
  type OrganizationProviderContext,
} from "../../providers/context"
type StorageContext = BuildContext | OrganizationProviderContext

type Row = {
  organization_id: string
  legacy_project_id: string | null
  id: string
  name: string
  config_json: StorageConnection["config"]
  encrypted_credentials: string
  revision: number
  created_at: Date
}
const publicConnection = (row: Row): StorageConnection => ({
  id: row.id,
  name: row.name,
  config: row.config_json,
  revision: row.revision,
  createdAt: new Date(row.created_at).toISOString(),
})
export async function listStorageConnections(context: StorageContext) {
  const { organizationId } = await providerContext(context)
  const rows = await context.database.execute<Row>(
    sql`SELECT * FROM build_storage_connections WHERE organization_id=${organizationId} ORDER BY name,id LIMIT 200`
  )
  return { items: rows.rows.map(publicConnection) }
}
export async function storageConnection(context: StorageContext, id: string) {
  const { organizationId } = await providerContext(context)
  const rows = await context.database.execute<Row>(
    sql`SELECT * FROM build_storage_connections WHERE organization_id=${organizationId} AND id=${id}::uuid`
  )
  if (!rows.rows[0])
    throw new TracerError(
      "NOT_FOUND",
      "Storage connection is unavailable in this organization."
    )
  return rows.rows[0]
}
export function storageCredentials(context: StorageContext, row: Row) {
  if (context.organizationId && context.organizationId !== row.organization_id)
    throw new TracerError(
      "NOT_FOUND",
      "Storage connection is unavailable in this organization."
    )
  return JSON.parse(
    decryptProviderKey(
      row.encrypted_credentials,
      row.legacy_project_id ?? organizationCredentialScope(row.organization_id),
      `storage:${row.id}`
    )
  ) as Record<string, string>
}
export async function saveStorageConnection(
  context: StorageContext,
  raw: unknown
) {
  const { organizationId } = await providerContext(context)
  const input = storageConnectionInputSchema.parse(raw)
  const previous = input.id
    ? await storageConnection(context, input.id)
    : undefined
  if (
    previous &&
    (input.expectedRevision !== previous.revision ||
      JSON.stringify(storageConfigSchema.parse(previous.config_json)) !==
        JSON.stringify(input.config))
  )
    throw new TracerError(
      "VALIDATION_ERROR",
      "Reload the connection before editing. Its bucket, prefix and provider cannot change; create a new connection to move storage."
    )
  const credentials =
    input.credentials ?? (previous ? storageCredentials(context, previous) : {})
  if (input.config.provider === "s3")
    z.object({
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().optional(),
    })
      .strict()
      .parse(credentials)
  else
    z.object({ clientEmail: z.email(), privateKey: z.string().min(32) })
      .strict()
      .parse(credentials)
  const id = input.id ?? randomUUID()
  // Verify the configured prefix, without listing unrelated bucket contents.
  const client = objectStorage(input.config, credentials)
  const probe = `${input.config.prefix ? input.config.prefix + "/" : ""}.datool-check/${id}/${randomUUID()}`
  try {
    await client.put(probe, Buffer.from("datool"))
    const bytes = await client.get(probe)
    if (bytes.toString() !== "datool")
      throw new Error("Storage verification failed.")
  } finally {
    await client.remove(probe).catch(() => undefined)
    client.close()
  }
  const encrypted = encryptProviderKey(
    JSON.stringify(credentials),
    organizationCredentialScope(organizationId),
    `storage:${id}`
  )
  const rows = previous
    ? await context.database.execute<Row>(
        sql`UPDATE build_storage_connections SET name=${input.name},encrypted_credentials=${encrypted},legacy_project_id=NULL,revision=revision+1 WHERE organization_id=${organizationId} AND id=${id}::uuid AND revision=${input.expectedRevision} RETURNING *`
      )
    : await context.database.execute<Row>(
        sql`INSERT INTO build_storage_connections(id,organization_id,name,provider,config_json,encrypted_credentials) VALUES(${id}::uuid,${organizationId},${input.name},${input.config.provider},${JSON.stringify(input.config)}::jsonb,${encrypted}) RETURNING *`
      )
  if (!rows.rows[0])
    throw new TracerError(
      "VALIDATION_ERROR",
      "The storage connection changed. Reload before retrying."
    )
  return publicConnection(rows.rows[0])
}
export async function removeStorageConnection(
  context: StorageContext,
  id: string
) {
  const { organizationId } = await providerContext(context)
  await storageConnection(context, id)
  const rows = await context.database.execute(
    sql`DELETE FROM build_storage_connections c WHERE c.organization_id=${organizationId} AND c.id=${id}::uuid AND NOT EXISTS(SELECT 1 FROM build_drives d WHERE d.organization_id=c.organization_id AND d.storage_connection_id=c.id) RETURNING id`
  )
  if (!rows.rows.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "This storage connection is used by a drive and cannot be removed."
    )
  return { deleted: true }
}
