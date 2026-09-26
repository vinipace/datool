import { NewAlertPage } from "@/components/workspace/alert-editor-page"
import { pageMetadata } from "@/lib/page-metadata"
import { alertPageAccess } from "@/src/server/alerts/page-access"

export const metadata = pageMetadata("newAlert")

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>
  searchParams: Promise<{ template?: string | string[] }>
}) {
  const [{ projectSlug }, { template }] = await Promise.all([
    params,
    searchParams,
  ])
  const access = await alertPageAccess(projectSlug, "/new")
  return (
    <NewAlertPage
      key={access.projectId}
      {...access}
      templateId={typeof template === "string" ? template : undefined}
    />
  )
}
