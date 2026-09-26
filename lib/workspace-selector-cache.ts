import { QueryClient } from "@tanstack/react-query"

export const workspaceSelectorKeys = {
  organizations: ["workspace-organizations"] as const,
  projects: (organizationId: string) =>
    ["workspace-projects", organizationId] as const,
  projectSearch: (organizationId: string, search: string) =>
    [...workspaceSelectorKeys.projects(organizationId), search.trim()] as const,
}

/** Owned by the mounted workspace shell, never shared between browser sessions. */
export function createWorkspaceSelectorClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: false,
      },
    },
  })
}
