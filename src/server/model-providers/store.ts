import { DATOOL_PROVIDER } from "@/src/lib/execution-credits"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  GATEWAY_PROVIDER,
  MODEL_PROVIDER_IDS,
  modelProviders,
  type ModelProvider,
  type ProviderStatus,
} from "@/src/lib/model-providers"
import {
  projectProviderContext,
  type OrganizationProviderContext,
} from "../providers/context"
import {
  organizationConnections,
  effectiveConnections,
  connectionSecret,
  connectionInfo,
  saveConnection,
  changeConnection,
  ProviderConnectionError,
  type ProviderConnectionRow,
} from "../providers/connections"

const statuses = (rows: ProviderConnectionRow[]): ProviderStatus[] =>
  MODEL_PROVIDER_IDS.filter((id) => id !== DATOOL_PROVIDER).map((id) => {
    const row = rows.find((entry) => entry.provider === id)
    return {
      id,
      name: modelProviders[id].name,
      configured: !!row,
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    }
  })
export async function getProjectProviders(
  projectId: string,
  database?: TracerDatabase
) {
  return statuses(
    await effectiveConnections(
      await projectProviderContext(projectId, database),
      "model"
    )
  )
}
export async function getOrganizationProviders(
  context: OrganizationProviderContext
) {
  const rows = await organizationConnections(context, "model")
  return {
    providers: statuses(rows.filter((row) => row.is_default)),
    connections: await connectionInfo(context, rows),
  }
}
export async function saveOrganizationProviderKey(
  context: OrganizationProviderContext,
  provider: ModelProvider,
  apiKey: string,
  connectionId?: string
) {
  if (provider === DATOOL_PROVIDER)
    throw new ProviderConnectionError(
      "Datool credentials are managed by the server."
    )
  await saveConnection(context, "model", provider, apiKey, connectionId)
}
export async function removeOrganizationProviderKey(
  context: OrganizationProviderContext,
  provider: ModelProvider,
  connectionId?: string
) {
  const rows = await organizationConnections(context, "model")
  const row = rows.find(
    (row) =>
      row.provider === provider &&
      (connectionId ? row.id === connectionId : row.is_default)
  )
  if (row) await changeConnection(context, "model", row.id, "remove")
}
export async function getProjectProviderKey(
  projectId: string,
  provider: ModelProvider,
  database?: TracerDatabase
) {
  if (provider === DATOOL_PROVIDER)
    throw new Error(
      "Datool Scorer Model requires the managed execution transport."
    )
  const rows = await effectiveConnections(
    await projectProviderContext(projectId, database),
    "model"
  )
  const row = rows.find((row) => row.provider === provider)
  if (!row)
    throw new Error(
      `Configure ${modelProviders[provider].name} in Organization settings → AI providers to run this model.`
    )
  return connectionSecret(row)!
}
export const getGatewayKey = (projectId: string) =>
  getProjectProviderKey(projectId, GATEWAY_PROVIDER)
