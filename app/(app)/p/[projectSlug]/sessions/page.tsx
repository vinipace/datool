import { SessionsPage } from "@/components/tracer/sessions-page"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("sessions")

export default async function ProjectSessionsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization } = await requireActiveOrganization()
  return (
    <SessionsPage
      key={projectSlug}
      buildEnabled={buildEnabled(organization.id)}
    />
  )
}
