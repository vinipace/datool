import type { ReactNode } from "react"
import { ReviewSessionRoute } from "@/components/tracer/review-session-route"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("reviewSession")

export default async function Layout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectSlug: string; reviewId: string }>
}) {
  const { projectSlug, reviewId } = await params
  return (
    <>
      <ReviewSessionRoute
        key={`${projectSlug}:${reviewId}`}
        sessionId={reviewId}
      />
      {children}
    </>
  )
}
