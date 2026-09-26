import { NewScorerPage } from "@/components/tracer/scorers-page"
import { parseScorerTraceIds } from "@/src/lib/tracer/scorer-traces"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("newScorer")

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ traceIds?: string | string[] }>
}) {
  const traceIds = parseScorerTraceIds((await searchParams).traceIds)
  return <NewScorerPage key={traceIds.join(",")} traceIds={traceIds} />
}
