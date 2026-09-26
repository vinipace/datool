import { AsyncLocalStorage } from "node:async_hooks"
import { join } from "node:path"
import type { WorkspaceScope } from "@/src/lib/auth/permissions"

export type WorkspaceIdentity = {
  organizationId: string
  projectId: string
  apiKeyId?: string
  apiKeyName?: string
  clientId?: string
  userId?: string
  scopes: readonly string[]
  kind: "session" | "api-key" | "oauth"
}
const key = Symbol.for("datool.workspace.identity")
const globalContext = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<WorkspaceIdentity>
}
const context = (globalContext[key] ??=
  new AsyncLocalStorage<WorkspaceIdentity>())
export const workspaceIdentity = () => context.getStore()
export const withWorkspace = <T>(
  identity: WorkspaceIdentity,
  action: () => T
): T => context.run(identity, action)
export const organizationAuthEnabled = () => true
export function dataDirectory(
  organizationId = workspaceIdentity()?.organizationId
) {
  const root = process.env.DATOOL_DATA_DIR ?? join(process.cwd(), ".data")
  if (!organizationId)
    throw new Error("Organization and project context is required.")
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(organizationId))
    throw new Error("Invalid organization ID.")
  const projectId = workspaceIdentity()?.projectId
  if (!projectId || !/^[A-Za-z0-9_-]{1,200}$/.test(projectId))
    throw new Error("Project context is required.")
  return join(root, "organizations", organizationId, "projects", projectId)
}
export function hasScope(identity: WorkspaceIdentity, scope: WorkspaceScope) {
  return identity.scopes.includes(scope)
}
