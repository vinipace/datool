import { PerformancePage } from "@/components/tracer/performance-page"
import { buildEnabled } from "@/lib/build/config"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("agents")

export default async function ProjectAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>
  searchParams: Promise<{ filter?: string | string[] }>
}) {
  const [{ projectSlug }, query] = await Promise.all([params, searchParams])
  const initialFilter =
    typeof query.filter === "string" ? query.filter : undefined
  const { organization } = await requireActiveOrganization()
  return (
    <PerformancePage
      key={JSON.stringify([projectSlug, initialFilter])}
      model="agents"
      includeManagedAgents={buildEnabled(organization.id)}
      initialFilter={initialFilter}
    />
  )
}
