import { notFound, redirect } from "next/navigation"
import { getProjectByOrganizationSlug } from "@/lib/project-access"
import { requireActiveOrganization } from "@/lib/workspace-access"
export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/settings/storage-providers`
  )
  if (!(await getProjectByOrganizationSlug(projectSlug, organization.id)))
    notFound()
  redirect("/settings/storage-providers")
}
