import { DashboardDetailPage } from "@/components/tracer/dashboard-detail-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("dashboardDetail")

export default async function Page({
  params,
}: {
  params: Promise<{ dashboardId: string }>
}) {
  const { dashboardId } = await params
  return <DashboardDetailPage key={dashboardId} dashboardId={dashboardId} />
}
