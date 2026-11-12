import { notFound } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { ProjectDeploymentsPage } from "@/components/workspace/project-deployments-page"

export const metadata = pageMetadata("deployments")
export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string; deploymentId: string }>
}) {
  const { projectSlug, deploymentId } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/deployments`
  )
  if (!buildEnabled(organization.id)) notFound()
  return (
    <ProjectDeploymentsPage
      projectSlug={projectSlug}
      deploymentId={deploymentId}
      origin={new URL(process.env.BETTER_AUTH_URL!).origin}
    />
  )
}
