import { notFound } from "next/navigation"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"

export default async function BuildLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}/build`
  )
  if (!buildEnabled(organization.id)) notFound()
  return children
}
