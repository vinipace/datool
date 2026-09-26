import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { ModelProviderSettings } from "@/components/workspace/model-provider-settings"
import { pageMetadata } from "@/lib/page-metadata"
import {
  canManageProject,
  getProjectByOrganizationSlug,
  requireProjectAccess,
} from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("aiProviders")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/settings/ai-providers`
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
    <ModelProviderSettings
      key={project.id}
      projectId={project.id}
      canManage={canManageProject(authorization.access.role)}
    />
  )
}
