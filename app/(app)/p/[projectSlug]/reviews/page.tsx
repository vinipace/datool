import { ReviewsPage } from "@/components/tracer/reviews-page"
import { pageMetadata } from "@/lib/page-metadata"
export const metadata = pageMetadata("reviews")
export default async function Page({
  params,
}: {
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  return <ReviewsPage key={projectSlug} />
}
