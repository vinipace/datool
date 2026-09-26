import { headers } from "next/headers"
import { notFound } from "next/navigation"
import {
  canManageProject,
  getProjectByOrganizationSlug,
  requireProjectAccess,
} from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"

export async function alertPageAccess(projectSlug: string, suffix = "") {
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/alerts${suffix}`
  )
  const project = await getProjectByOrganizationSlug(
    projectSlug,
    organization.id
  )
  if (!project) notFound()
  const authorization = await requireProjectAccess(
    new Request("http://localhost", { headers: await headers() }),
    project.id
  )
  if (authorization.kind !== "ok") notFound()
  return {
    projectId: project.id,
    projectSlug: project.slug,
    canManage: canManageProject(authorization.access.role),
  }
}
