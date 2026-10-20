import { pageMetadata } from "@/lib/page-metadata"
import { redirect } from "next/navigation"

export const metadata = pageMetadata("dashboards")

export default async function BuildAnalyticsRoute({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  redirect(`/p/${encodeURIComponent(projectSlug)}/dashboards`)
}
