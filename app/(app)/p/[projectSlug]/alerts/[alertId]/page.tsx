import { AlertDetailPage } from "@/components/workspace/alerts-page"
import { pageMetadata } from "@/lib/page-metadata"
import { alertPageAccess } from "@/src/server/alerts/page-access"

export const metadata = pageMetadata("alertDetail")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string; alertId: string }>
}) {
  const { projectSlug, alertId } = await params
  const access = await alertPageAccess(
    projectSlug,
    `/${encodeURIComponent(alertId)}`
  )
  return (
    <AlertDetailPage
      key={`${access.projectId}:${alertId}`}
      {...access}
      alertId={alertId}
    />
  )
}
