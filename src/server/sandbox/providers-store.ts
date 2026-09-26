import { managedProjectAvailable } from "@/src/server/execution-credits/config"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  decryptProviderKey,
  encryptProviderKey,
} from "@/src/server/model-providers/secrets"
import {
  sandboxCredentialsSchema,
  sandboxExecutionOrder,
  sandboxProviderIds,
  type SandboxCredentials,
  type SandboxProviderId,
  type SandboxProviderInput,
  type SandboxProviderSettings,
} from "@/src/lib/sandbox-providers"

type SettingsRow = {
  providers: Partial<Record<SandboxProviderId, string | null>>
  default_provider: SandboxProviderId | null
}
const initialSettings = (): SettingsRow => ({
  providers: { local: null },
  default_provider: "local",
})
export class SandboxSettingsValidationError extends Error {}

function credentials(
  projectId: string,
  row: SettingsRow,
  provider: SandboxProviderId
): SandboxCredentials {
  if (provider === "local" || provider === "datool") return { provider }
  const encrypted = row.providers[provider]
  if (!encrypted) throw new Error("Sandbox credentials are unavailable.")
  const config = sandboxCredentialsSchema.parse(
    JSON.parse(decryptProviderKey(encrypted, projectId, `sandbox:${provider}`))
  )
  if (config.provider !== provider)
    throw new Error("Sandbox credentials do not match the provider.")
  return config
}

async function readSettings(
  projectId: string,
  database?: TracerDatabase
): Promise<SettingsRow> {
  const result = database
    ? await database.execute<SettingsRow>(
        sql`SELECT providers, default_provider FROM project_sandbox_settings WHERE project_id = ${projectId}`
      )
    : await db.query<SettingsRow>(
        "SELECT providers, default_provider FROM project_sandbox_settings WHERE project_id = $1",
        [projectId]
      )
  return result.rows[0] ?? initialSettings()
}

function configuredProviders(row: SettingsRow) {
  return sandboxProviderIds.filter((id) => Object.hasOwn(row.providers, id))
}

export async function getSandboxProviderSettings(
  projectId: string
): Promise<SandboxProviderSettings> {
  const row = await readSettings(projectId)
  return {
    defaultProvider: row.default_provider,
    executionOrder: sandboxExecutionOrder(
      configuredProviders(row),
      row.default_provider
    ),
    providers: sandboxProviderIds.map((id) => {
      const configured = Object.hasOwn(row.providers, id)
      if (id === "vercel" && configured) {
        // A rotated/unavailable encryption key must not prevent replacing credentials.
        try {
          const config = credentials(projectId, row, id)
          if (config.provider === "vercel")
            return {
              id,
              configured,
              teamId: config.teamId,
              projectId: config.projectId,
            }
        } catch {
          /* Keep the configured state, without exposing secrets or errors. */
        }
      }
      return { id, configured }
    }),
  }
}

export async function getSandboxExecutionProviders(
  projectId: string,
  database?: TracerDatabase
) {
  const row = await readSettings(projectId, database)
  return sandboxExecutionOrder(
    configuredProviders(row),
    row.default_provider
  ).map((id) => ({
    id,
    credentials: () => credentials(projectId, row, id),
  }))
}

export async function updateSandboxProviderSettings(
  projectId: string,
  action:
    | { type: "configure"; input: SandboxProviderInput }
    | { type: "remove" | "default"; provider: SandboxProviderId }
) {
  const target =
    action.type === "configure" ? action.input.provider : action.provider
  if (
    target === "datool" &&
    action.type !== "remove" &&
    !(await managedProjectAvailable(projectId, "sandbox"))
  )
    throw new SandboxSettingsValidationError(
      "Datool Sandbox requires an active paid plan and a configured managed runtime."
    )
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "INSERT INTO project_sandbox_settings (project_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [projectId]
    )
    const result = await client.query<SettingsRow>(
      "SELECT providers, default_provider FROM project_sandbox_settings WHERE project_id = $1 FOR UPDATE",
      [projectId]
    )
    const row = result.rows[0]
    if (action.type === "configure") {
      const provider = action.input.provider
      let previous: SandboxCredentials | undefined
      if (Object.hasOwn(row.providers, provider)) {
        try {
          previous = credentials(projectId, row, provider)
        } catch {
          /* Full replacement can recover an unreadable key. */
        }
      }
      const parsed = sandboxCredentialsSchema.safeParse({
        ...previous,
        ...action.input,
      })
      if (!parsed.success)
        throw new SandboxSettingsValidationError(
          "Provide all credentials to configure this sandbox provider."
        )
      row.providers[provider] =
        provider === "local" || provider === "datool"
          ? null
          : encryptProviderKey(
              JSON.stringify(parsed.data),
              projectId,
              `sandbox:${provider}`
            )
      row.default_provider ??= provider
    } else if (action.type === "default") {
      if (!Object.hasOwn(row.providers, action.provider))
        throw new SandboxSettingsValidationError(
          "Configure this provider before making it the default."
        )
      row.default_provider = action.provider
    } else {
      delete row.providers[action.provider]
      if (row.default_provider === action.provider)
        row.default_provider = configuredProviders(row)[0] ?? null
    }
    await client.query(
      "UPDATE project_sandbox_settings SET providers = $2::jsonb, default_provider = $3, updated_at = now() WHERE project_id = $1",
      [projectId, JSON.stringify(row.providers), row.default_provider]
    )
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
