import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { SandboxProviderSettings } from "@/components/workspace/sandbox-provider-settings"
import { pageMetadata } from "@/lib/page-metadata"
import {
  canManageProject,
  getProjectByOrganizationSlug,
  requireProjectAccess,
} from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("sandboxProviders")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/settings/sandbox-providers`
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
    <SandboxProviderSettings
      key={project.id}
      projectId={project.id}
      canManage={canManageProject(authorization.access.role)}
    />
  )
}
