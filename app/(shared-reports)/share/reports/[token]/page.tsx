import { notFound } from "next/navigation"
import { readPublicReport } from "@/src/server/tracer/public-reports"
import { PublicReportPage } from "@/components/tracer/public-report-page"
export const dynamic = "force-dynamic"
export const metadata = {
  title: "Shared report",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
}
export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const report = await readPublicReport(token)
  if (!report) notFound()
  return <PublicReportPage report={report} />
}
