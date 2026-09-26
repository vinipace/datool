import { EditAlertPage } from "@/components/workspace/alert-editor-page"
import { pageMetadata } from "@/lib/page-metadata"
import { alertPageAccess } from "@/src/server/alerts/page-access"

export const metadata = pageMetadata("editAlert")

export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string; alertId: string }>
}) {
  const { projectSlug, alertId } = await params
  const access = await alertPageAccess(
    projectSlug,
    `/${encodeURIComponent(alertId)}/edit`
  )
  return (
    <EditAlertPage
      key={`${access.projectId}:${alertId}`}
      {...access}
      alertId={alertId}
    />
  )
}
