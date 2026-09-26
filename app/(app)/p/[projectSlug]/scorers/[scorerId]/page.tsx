import { ScorerDetailPage } from "@/components/tracer/scorers-page"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("scorerDetail")

export default async function Page({
  params,
}: {
  params: Promise<{ scorerId: string }>
}) {
  const { scorerId } = await params
  return <ScorerDetailPage key={scorerId} scorerId={scorerId} />
}
