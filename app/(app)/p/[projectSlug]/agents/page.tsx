import { PerformancePage } from "@/components/tracer/performance-page"
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
  return (
    <PerformancePage
      key={JSON.stringify([projectSlug, initialFilter])}
      model="agents"
      initialFilter={initialFilter}
    />
  )
}
