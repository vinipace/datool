import { ReportDetailPage } from "@/components/tracer/report-detail-page"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("reportDetail")
export default async function Page({
  params,
}: {
  params: Promise<{ reportNumber: string }>
}) {
  const { reportNumber } = await params
  return <ReportDetailPage key={reportNumber} reportNumber={reportNumber} />
}
