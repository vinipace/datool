export const mcpScopes = [
  "apps:read",
  "apps:write",
  "reviews:read",
  "reviews:write",
  "metrics:read",
  "scorers:read",
  "scorers:write",
  "views:read",
  "views:write",
  "datasets:read",
  "datasets:write",
  "dashboards:read",
  "dashboards:write",
  "traces:read",
  "evals:read",
  "evals:write",
] as const
export const workspaceScopes = [
  ...mcpScopes,
  "prompts:read",
  "prompts:write",
  "traces:write",
  "playgrounds:read",
  "playgrounds:write",
] as const
export type WorkspaceScope = (typeof workspaceScopes)[number]
export function roleScopes(role: string): readonly WorkspaceScope[] {
  if (
    role
      .split(",")
      .some((value) => ["owner", "admin", "member"].includes(value.trim()))
  )
    return workspaceScopes
  return []
}
export function isOrganizationAdmin(role: string) {
  return role
    .split(",")
    .some((value) => value.trim() === "owner" || value.trim() === "admin")
}
export function permissionStatements(scopes: readonly string[]) {
  const permissions: Record<string, string[]> = {}
  for (const scope of scopes) {
    const [resource, action] = scope.split(":")
    ;(permissions[resource] ??= []).push(action)
  }
  return permissions
}
