import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { ProjectSettingsPage } from "@/components/workspace/project-settings-page"
import { pageMetadata } from "@/lib/page-metadata"
import {
  canManageProject,
  getProjectByOrganizationSlug,
  requireProjectAccess,
} from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("projectSettings")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/settings`
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
  return (
    <ProjectSettingsPage
      key={project.id}
      organization={organization}
      project={{ id: project.id, name: project.name, slug: project.slug }}
      canManage={canManageProject(authorization.access.role)}
    />
  )
}
