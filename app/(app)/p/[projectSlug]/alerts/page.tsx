import { AlertsPage } from "@/components/workspace/alerts-page"
import { pageMetadata } from "@/lib/page-metadata"
import { alertPageAccess } from "@/src/server/alerts/page-access"

export const metadata = pageMetadata("alerts")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const access = await alertPageAccess(projectSlug, "")
  return <AlertsPage key={access.projectId} {...access} />
}
