import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import type { ProviderConnectionInfo } from "@/src/lib/provider-connections"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "../model-providers/secrets"
import {
  organizationCredentialScope,
  type OrganizationProviderContext,
} from "./context"

export type ConnectionKind = "model" | "sandbox"
export type ProviderConnectionRow = {
  id: string
  organization_id: string
  kind: ConnectionKind
  provider: string
  name: string
  encrypted_credentials: string | null
  legacy_project_id: string | null
  is_default: boolean
  updated_at: Date
}
export class ProviderConnectionError extends Error {}
export async function organizationConnections(
  context: OrganizationProviderContext,
  kind: ConnectionKind
) {
  return (
    await context.database.execute<ProviderConnectionRow>(
      sql`SELECT * FROM organization_provider_connections WHERE organization_id=${context.organizationId} AND kind=${kind} ORDER BY provider,is_default DESC,name,id`
    )
  ).rows
}
export async function effectiveConnections(
  context: OrganizationProviderContext & { projectId: string },
  kind: ConnectionKind
) {
  return (
    await context.database
      .execute<ProviderConnectionRow>(sql`SELECT DISTINCT ON (c.provider) c.* FROM organization_provider_connections c
    LEFT JOIN project_provider_bindings b ON b.organization_id=c.organization_id AND b.connection_id=c.id AND b.project_id=${context.projectId}
    WHERE c.organization_id=${context.organizationId} AND c.kind=${kind} AND (c.is_default OR b.connection_id IS NOT NULL)
    ORDER BY c.provider,(b.connection_id IS NOT NULL) DESC`)
  ).rows
}
export function connectionSecret(row: ProviderConnectionRow) {
  if (!row.encrypted_credentials) return null
  return decryptProviderKey(
    row.encrypted_credentials,
    row.legacy_project_id ?? organizationCredentialScope(row.organization_id),
    row.kind === "model" ? row.provider : `sandbox:${row.provider}`
  )
}
export async function connectionInfo(
  context: OrganizationProviderContext,
  rows: ProviderConnectionRow[]
): Promise<ProviderConnectionInfo[]> {
  const bindings = (
    await context.database.execute<{
      connection_id: string
      id: string
      name: string
    }>(
      sql`SELECT b.connection_id,p.id,p.name FROM project_provider_bindings b JOIN project p ON p.id=b.project_id AND p.organization_id=b.organization_id WHERE b.organization_id=${context.organizationId} ORDER BY p.name,p.id`
    )
  ).rows
  return rows.map((row) => ({
    connectionId: row.id,
    provider: row.provider,
    name: row.name,
    isDefault: row.is_default,
    projects: bindings
      .filter((b) => b.connection_id === row.id)
      .map(({ id, name }) => ({ id, name })),
  }))
}
export async function saveConnection(
  context: OrganizationProviderContext,
  kind: ConnectionKind,
  provider: string,
  secret: string | null,
  connectionId?: string
) {
  const id = connectionId ?? randomUUID()
  const encrypted =
    secret === null
      ? null
      : encryptProviderKey(
          secret,
          organizationCredentialScope(context.organizationId),
          kind === "model" ? provider : `sandbox:${provider}`
        )
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM organization WHERE id=${context.organizationId} FOR UPDATE`
    )
    if (connectionId) {
      const changed = await tx.execute(
        sql`UPDATE organization_provider_connections SET encrypted_credentials=${encrypted},legacy_project_id=NULL,updated_at=now() WHERE organization_id=${context.organizationId} AND kind=${kind} AND provider=${provider} AND id=${id}::uuid RETURNING id`
      )
      if (!changed.rows.length)
        throw new ProviderConnectionError(
          "Provider connection is unavailable in this organization."
        )
    } else {
      const existing = (
        await tx.execute<ProviderConnectionRow>(
          sql`SELECT * FROM organization_provider_connections WHERE organization_id=${context.organizationId} AND kind=${kind} AND provider=${provider} AND is_default FOR UPDATE`
        )
      ).rows[0]
      if (existing)
        await tx.execute(
          sql`UPDATE organization_provider_connections SET encrypted_credentials=${encrypted},legacy_project_id=NULL,updated_at=now() WHERE id=${existing.id}::uuid`
        )
      else
        await tx.execute(
          sql`INSERT INTO organization_provider_connections(id,organization_id,kind,provider,name,encrypted_credentials,is_default) VALUES(${id}::uuid,${context.organizationId},${kind},${provider},${provider},${encrypted},true)`
        )
    }
  })
}
export async function changeConnection(
  context: OrganizationProviderContext,
  kind: ConnectionKind,
  connectionId: string,
  action: "default" | "remove" | "inherit"
) {
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM organization WHERE id=${context.organizationId} FOR UPDATE`
    )
    const row = (
      await tx.execute<ProviderConnectionRow>(
        sql`SELECT * FROM organization_provider_connections WHERE organization_id=${context.organizationId} AND kind=${kind} AND id=${connectionId}::uuid FOR UPDATE`
      )
    ).rows[0]
    if (!row)
      throw new ProviderConnectionError(
        "Provider connection is unavailable in this organization."
      )
    if (action === "default") {
      await tx.execute(
        sql`UPDATE organization_provider_connections SET is_default=false WHERE organization_id=${context.organizationId} AND kind=${kind} AND provider=${row.provider} AND is_default`
      )
      await tx.execute(
        sql`UPDATE organization_provider_connections SET is_default=true WHERE id=${row.id}::uuid`
      )
    } else if (action === "inherit") {
      if (
        !row.is_default &&
        !(
          await tx.execute(
            sql`SELECT id FROM organization_provider_connections WHERE organization_id=${context.organizationId} AND kind=${kind} AND provider=${row.provider} AND is_default`
          )
        ).rows.length
      )
        throw new ProviderConnectionError(
          "Configure an organization default before changing project assignments."
        )
      await tx.execute(
        sql`DELETE FROM project_provider_bindings WHERE organization_id=${context.organizationId} AND connection_id=${row.id}::uuid`
      )
    } else {
      if (
        (
          await tx.execute(
            sql`SELECT project_id FROM project_provider_bindings WHERE organization_id=${context.organizationId} AND connection_id=${row.id}::uuid LIMIT 1`
          )
        ).rows.length
      )
        throw new ProviderConnectionError(
          "This connection is assigned to projects. Switch them to the organization default before removing it."
        )
      await tx.execute(
        sql`DELETE FROM organization_provider_connections WHERE id=${row.id}::uuid`
      )
    }
  })
}
