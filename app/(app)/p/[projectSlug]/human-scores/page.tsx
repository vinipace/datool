import { HumanScoresPage } from "@/components/tracer/human-scores-page"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("humanScores")
export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  return <HumanScoresPage key={projectSlug} />
}
