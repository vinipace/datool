"use client"
import { ProjectScope } from "./project-scope-context"
import { useMemo } from "react"
export function ProjectScopeProvider({ projectId, organizationId, prefix, children }: { projectId: string; organizationId: string; prefix: string; children: React.ReactNode }) {
  const scope = useMemo(() => ({ projectId, organizationId }), [projectId, organizationId])
  return <ProjectScope.Provider value={scope}><div data-project-id={projectId} data-project-prefix={prefix} data-organization-id={organizationId}>{children}</div></ProjectScope.Provider>
}
