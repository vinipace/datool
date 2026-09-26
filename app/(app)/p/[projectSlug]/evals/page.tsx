import { EvalsPage } from "@/components/tracer/evals-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("evals")

export default async function ProjectEvalsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params
  return <EvalsPage key={projectSlug} />
}
