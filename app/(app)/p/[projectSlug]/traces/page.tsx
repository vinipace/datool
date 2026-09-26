import { TracesPage } from "@/components/tracer/traces-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("traces")

export default async function ProjectTracesPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params
  return <TracesPage key={projectSlug} />
}
