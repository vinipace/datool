import { DatasetDetailPage } from "@/components/tracer/datasets-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("datasetDetail")

export default async function ProjectDatasetDetailPage({ params }: { params: Promise<{ projectSlug: string; datasetId: string }> }) {
  const { projectSlug, datasetId } = await params
  return <DatasetDetailPage key={`${projectSlug}:${datasetId}`} datasetId={datasetId} />
}
