import { EvalDetailPage } from "@/components/tracer/evals-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("evalDetail")

export default async function ProjectEvalDetailPage({ params }: { params: Promise<{ projectSlug: string; evalId: string }> }) {
  const { projectSlug, evalId } = await params
  return <EvalDetailPage key={`${projectSlug}:${evalId}`} runId={evalId} />
}
