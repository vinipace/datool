export type WorkspaceOrganization = { id: string; name: string; slug: string }

export type WorkspaceProject = {
  id: string
  organizationId: string
  name: string
  slug: string
  createdAt: string
  updatedAt: string
  traceCount?: number
  evalCount?: number
  datasetCount?: number
}

export type ProjectPage = {
  projects: WorkspaceProject[]
  page: number
  pageSize: number
  total: number
}

export async function workspaceRequest<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      body.error?.message ?? "Unable to complete the request. Try again."
    )
  return body as T
}

export function listWorkspaceProjects(
  organizationId: string,
  options: {
    signal: AbortSignal
    search?: string
    page?: number
    pageSize?: number
    includeStats?: boolean
  }
) {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 25),
    q: options.search?.trim() ?? "",
  })
  if (options.includeStats) query.set("includeStats", "true")
  return workspaceRequest<ProjectPage>(
    `/api/organizations/${encodeURIComponent(organizationId)}/projects?${query}`,
    { signal: options.signal }
  )
}

export function projectHref(
  organization: WorkspaceOrganization,
  project: Pick<WorkspaceProject, "slug">,
  page: "traces" | "projects" = "traces"
) {
  return `${projectWorkspaceHref(organization, project)}/${page}`
}

export function projectWorkspaceHref(
  organization: WorkspaceOrganization,
  project: Pick<WorkspaceProject, "slug">
) {
  return `/p/${encodeURIComponent(project.slug)}`
}

export function organizationSettingsHref(path: "api-keys" | "settings/mcp") {
  return `/${path}`
}
