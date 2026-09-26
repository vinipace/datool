import { DashboardsPage } from "@/components/tracer/dashboards-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("dashboards")

export default function Page() {
  return <DashboardsPage />
}
