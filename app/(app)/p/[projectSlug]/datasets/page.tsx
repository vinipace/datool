import { DatasetsPage } from "@/components/tracer/datasets-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("datasets")

export default async function ProjectDatasetsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params
  return <DatasetsPage key={projectSlug} />
}
