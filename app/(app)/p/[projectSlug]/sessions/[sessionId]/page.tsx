import { SessionDetailPage } from "@/components/tracer/sessions-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("sessionDetail")

export default async function ProjectSessionDetailPage({ params }: { params: Promise<{ projectSlug: string; sessionId: string }> }) {
  const { projectSlug, sessionId } = await params
  return <SessionDetailPage key={`${projectSlug}:${sessionId}`} sessionId={sessionId} />
}
