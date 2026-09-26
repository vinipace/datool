import { DATOOL_PROVIDER } from "@/src/lib/execution-credits"
import { sql } from "drizzle-orm"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { db } from "@/lib/db"
import {
  GATEWAY_PROVIDER,
  MODEL_PROVIDER_IDS,
  modelProviders,
  type ModelProvider,
  type ProviderStatus,
} from "@/src/lib/model-providers"
import { decryptProviderKey, encryptProviderKey } from "./secrets"

export async function getProjectProviders(
  projectId: string
): Promise<ProviderStatus[]> {
  const result = await db.query<{ provider: ModelProvider; updated_at: Date }>(
    "SELECT provider, updated_at FROM project_model_provider WHERE project_id = $1",
    [projectId]
  )
  return MODEL_PROVIDER_IDS.filter((id) => id !== DATOOL_PROVIDER).map((id) => {
    const row = result.rows.find((entry) => entry.provider === id)
    return {
      id,
      name: modelProviders[id].name,
      configured: Boolean(row),
      updatedAt: row?.updated_at.toISOString() ?? null,
    }
  })
}

export async function saveProjectProviderKey(
  projectId: string,
  provider: ModelProvider,
  apiKey: string
) {
  if (provider === DATOOL_PROVIDER)
    throw new Error("Datool credentials are managed by the server.")
  const encrypted = encryptProviderKey(apiKey, projectId, provider)
  await db.query(
    `INSERT INTO project_model_provider (project_id, provider, encrypted_api_key)
     VALUES ($1, $2, $3) ON CONFLICT (project_id, provider)
     DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, updated_at = now()`,
    [projectId, provider, encrypted]
  )
}

export async function removeProjectProviderKey(
  projectId: string,
  provider: ModelProvider
) {
  await db.query(
    "DELETE FROM project_model_provider WHERE project_id = $1 AND provider = $2",
    [projectId, provider]
  )
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
  const result = database
    ? await database.execute<{ encrypted_api_key: string }>(
        sql`SELECT encrypted_api_key FROM project_model_provider WHERE project_id = ${projectId} AND provider = ${provider}`
      )
    : await db.query<{ encrypted_api_key: string }>(
        "SELECT encrypted_api_key FROM project_model_provider WHERE project_id = $1 AND provider = $2",
        [projectId, provider]
      )
  if (!result.rows[0])
    throw new Error(
      `Configure ${modelProviders[provider].name} in this project's settings to run this model.`
    )
  return decryptProviderKey(
    result.rows[0].encrypted_api_key,
    projectId,
    provider
  )
}

export const getGatewayKey = (projectId: string) =>
  getProjectProviderKey(projectId, GATEWAY_PROVIDER)
