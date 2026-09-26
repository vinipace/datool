import { TraceDetailPage } from "@/components/tracer/traces-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("traceDetail")

export default async function ProjectTraceDetailPage({ params }: { params: Promise<{ projectSlug: string; traceId: string }> }) {
  const { projectSlug, traceId } = await params
  return <TraceDetailPage key={`${projectSlug}:${traceId}`} traceId={traceId} />
}
