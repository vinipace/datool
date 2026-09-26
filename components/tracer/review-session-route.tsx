"use client"

import { useParams } from "next/navigation"
import { ReviewSessionPage } from "./reviews-page"

/** The shared session layout retains drafts across trace route changes. */
export function ReviewSessionRoute({ sessionId }: { sessionId: string }) {
  const { traceId } = useParams<{ traceId?: string }>()
  return <ReviewSessionPage sessionId={sessionId} traceId={traceId} />
}
