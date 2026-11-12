import { notFound, redirect } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { ProjectDeploymentsPage } from "@/components/workspace/project-deployments-page"

export const metadata = pageMetadata("deployments")
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>
  searchParams: Promise<{ deployment?: string; tab?: string }>
}) {
  const { projectSlug } = await params
  const query = await searchParams
  if (query.deployment && /^[0-9a-f-]{36}$/i.test(query.deployment))
    redirect(
      `/p/${encodeURIComponent(projectSlug)}/deployments/${query.deployment}${query.tab === "sources" ? "?tab=sources" : ""}`
    )
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/deployments`
  )
  if (!buildEnabled(organization.id)) notFound()
  return (
    <ProjectDeploymentsPage
      projectSlug={projectSlug}
      origin={new URL(process.env.BETTER_AUTH_URL!).origin}
    />
  )
}
