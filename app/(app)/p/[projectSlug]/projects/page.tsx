import { ProjectsPage } from "@/components/workspace/projects-page"
import { pageMetadata } from "@/lib/page-metadata"
import { requireActiveOrganization } from "@/lib/workspace-access"

export const metadata = pageMetadata("projects")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(`/p/${encodeURIComponent(projectSlug)}/projects`)
  return <ProjectsPage organization={organization} />
}
