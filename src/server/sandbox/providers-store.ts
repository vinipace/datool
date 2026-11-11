import { sql } from "drizzle-orm"
import { managedOrganizationAvailable } from "@/src/server/execution-credits/config"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  sandboxCredentialsSchema,
  sandboxExecutionOrder,
  sandboxProviderIds,
  sandboxProviderNames,
  type SandboxCredentials,
  type SandboxProviderId,
  type SandboxProviderInput,
  type SandboxProviderSettings,
} from "@/src/lib/sandbox-providers"
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

export class SandboxSettingsValidationError extends ProviderConnectionError {}
type SettingsRow = { default_provider: SandboxProviderId | null }
async function settings(context: OrganizationProviderContext) {
  return (
    await context.database.execute<SettingsRow>(
      sql`SELECT default_provider FROM organization_sandbox_settings WHERE organization_id=${context.organizationId}`
    )
  ).rows[0]
}
const local = (organizationId: string): ProviderConnectionRow => ({
  id: "",
  organization_id: organizationId,
  kind: "sandbox",
  provider: "local",
  name: "Local container",
  encrypted_credentials: null,
  legacy_project_id: null,
  is_default: true,
  updated_at: new Date(0),
})
function credentials(row: ProviderConnectionRow): SandboxCredentials {
  if (row.provider === "local" || row.provider === "datool")
    return { provider: row.provider }
  const config = sandboxCredentialsSchema.parse(
    JSON.parse(connectionSecret(row)!)
  )
  if (config.provider !== row.provider)
    throw new Error("Sandbox credentials do not match the provider.")
  return config
}
function publicSettings(
  rows: ProviderConnectionRow[],
  defaultProvider: SandboxProviderId | null
): SandboxProviderSettings {
  const configured = rows.map((row) => row.provider as SandboxProviderId)
  return {
    defaultProvider,
    executionOrder: sandboxExecutionOrder(configured, defaultProvider),
    providers: sandboxProviderIds.map((id) => {
      const row = rows.find((row) => row.provider === id)
      if (row && id === "vercel")
        try {
          const config = credentials(row)
          if (config.provider === "vercel")
            return {
              id,
              configured: true,
              teamId: config.teamId,
              projectId: config.projectId,
            }
        } catch {
          /* Full replacement can recover unreadable credentials. */
        }
      return { id, configured: !!row }
    }),
  }
}
export async function getOrganizationSandboxSettings(
  context: OrganizationProviderContext
) {
  const config = await settings(context)
  const rows = await organizationConnections(context, "sandbox")
  const shared = rows.filter((row) => row.is_default)
  if (!config && !shared.length) shared.push(local(context.organizationId))
  const connections = await connectionInfo(context, rows)
  for (const item of connections) {
    const row = rows.find((row) => row.id === item.connectionId)!
    if (row.provider === "vercel")
      try {
        const config = credentials(row)
        if (config.provider === "vercel")
          item.metadata = { teamId: config.teamId, projectId: config.projectId }
      } catch {
        /* Keep secrets hidden. */
      }
  }
  return {
    ...publicSettings(
      shared,
      config?.default_provider ?? (config ? null : "local")
    ),
    connections,
  }
}
async function projectSettings(projectId: string, database?: TracerDatabase) {
  const context = await projectProviderContext(projectId, database)
  const config = await settings(context)
  const rows = await effectiveConnections(context, "sandbox")
  if (!config && !rows.length) rows.push(local(context.organizationId))
  const preference = (
    await context.database.execute<SettingsRow>(
      sql`SELECT default_provider FROM project_sandbox_preferences WHERE project_id=${projectId}`
    )
  ).rows[0]
  return {
    rows: preference && preference.default_provider === null ? [] : rows,
    defaultProvider: preference
      ? preference.default_provider
      : config
        ? config.default_provider
        : ("local" as const),
  }
}
export async function getSandboxProviderSettings(projectId: string) {
  const { rows, defaultProvider } = await projectSettings(projectId)
  return publicSettings(rows, defaultProvider)
}
export async function getSandboxExecutionProviders(
  projectId: string,
  database?: TracerDatabase
) {
  const { rows, defaultProvider } = await projectSettings(projectId, database)
  return sandboxExecutionOrder(
    rows.map((row) => row.provider as SandboxProviderId),
    defaultProvider
  ).map((id) => ({
    id,
    credentials: () => credentials(rows.find((row) => row.provider === id)!),
  }))
}
export async function getSandboxProviderCredentials(
  projectId: string,
  provider: SandboxProviderId,
  database?: TracerDatabase
) {
  const { rows } = await projectSettings(projectId, database)
  const row = rows.find((row) => row.provider === provider)
  if (!row)
    throw new SandboxSettingsValidationError(
      `${sandboxProviderNames[provider]} is not configured for this organization. Configure it in Organization settings → Sandbox providers, or select a configured provider for this agent.`
    )
  return credentials(row)
}
export async function updateOrganizationSandboxSettings(
  context: OrganizationProviderContext,
  action:
    | { type: "configure"; input: SandboxProviderInput; connectionId?: string }
    | {
        type: "remove" | "default"
        provider: SandboxProviderId
        connectionId?: string
      }
) {
  const target =
    action.type === "configure" ? action.input.provider : action.provider
  if (
    target === "datool" &&
    action.type !== "remove" &&
    !(await managedOrganizationAvailable(context.organizationId, "sandbox"))
  )
    throw new SandboxSettingsValidationError(
      "Datool Sandbox requires an active paid plan and a configured managed runtime."
    )
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM organization WHERE id=${context.organizationId} FOR UPDATE`
    )
    const scoped = { ...context, database: tx as unknown as TracerDatabase }
    if (!(await settings(scoped))) {
      await tx.execute(
        sql`INSERT INTO organization_sandbox_settings(organization_id,default_provider) VALUES(${context.organizationId},'local')`
      )
      await saveConnection(scoped, "sandbox", "local", null)
    }
    const rows = await organizationConnections(scoped, "sandbox")
    const previous = rows.find(
      (row) =>
        row.provider === target &&
        (action.connectionId ? row.id === action.connectionId : row.is_default)
    )
    if (action.type === "configure") {
      let prior: SandboxCredentials | undefined
      if (previous)
        try {
          prior = credentials(previous)
        } catch {
          /* Replacing all fields repairs credentials. */
        }
      const parsed = sandboxCredentialsSchema.safeParse({
        ...prior,
        ...action.input,
      })
      if (!parsed.success)
        throw new SandboxSettingsValidationError(
          "Provide all credentials to configure this sandbox provider."
        )
      await saveConnection(
        scoped,
        "sandbox",
        target,
        ["local", "datool"].includes(target)
          ? null
          : JSON.stringify(parsed.data),
        action.connectionId
      )
      await tx.execute(
        sql`UPDATE organization_sandbox_settings SET default_provider=coalesce(default_provider,${target}),updated_at=now() WHERE organization_id=${context.organizationId}`
      )
    } else if (action.type === "default") {
      if (!previous?.is_default)
        throw new SandboxSettingsValidationError(
          "Configure an organization provider before making it the default."
        )
      await tx.execute(
        sql`UPDATE organization_sandbox_settings SET default_provider=${target},updated_at=now() WHERE organization_id=${context.organizationId}`
      )
      await tx.execute(
        sql`DELETE FROM project_sandbox_preferences WHERE project_id IN (SELECT id FROM project WHERE organization_id=${context.organizationId})`
      )
    } else if (previous) {
      await changeConnection(scoped, "sandbox", previous.id, "remove")
      const remaining = (await organizationConnections(scoped, "sandbox"))
        .filter((row) => row.is_default)
        .sort(
          (a, b) =>
            sandboxProviderIds.indexOf(a.provider as SandboxProviderId) -
            sandboxProviderIds.indexOf(b.provider as SandboxProviderId)
        )
      if (!remaining.some((row) => row.provider === target))
        await tx.execute(
          sql`DELETE FROM project_sandbox_preferences p WHERE p.default_provider=${target}
            AND p.project_id IN (SELECT id FROM project WHERE organization_id=${context.organizationId})
            AND NOT EXISTS (SELECT 1 FROM project_provider_bindings b WHERE b.project_id=p.project_id AND b.organization_id=${context.organizationId} AND b.kind='sandbox' AND b.provider=${target})`
        )
      if (previous.is_default)
        await tx.execute(
          sql`UPDATE organization_sandbox_settings SET default_provider=${remaining[0]?.provider ?? null},updated_at=now() WHERE organization_id=${context.organizationId} AND default_provider=${target}`
        )
    }
  })
}
