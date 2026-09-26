import { PerformancePage } from "@/components/tracer/performance-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("workflows")

export default async function ProjectWorkflowsPage({
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
      model="workflows"
      initialFilter={initialFilter}
    />
  )
}
