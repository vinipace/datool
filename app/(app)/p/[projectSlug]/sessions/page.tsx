import { SessionsPage } from "@/components/tracer/sessions-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("sessions")

export default async function ProjectSessionsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params
  return <SessionsPage key={projectSlug} />
}
