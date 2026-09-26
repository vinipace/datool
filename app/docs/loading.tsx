import { Skeleton } from "@/components/ui/skeleton"
import { DocsPage } from "fumadocs-ui/page"

export default function DocumentationLoading() {
  return (
    <DocsPage
      className="space-y-6"
      role="status"
      aria-label="Loading documentation"
    >
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-5 w-3/4" />
      <span className="sr-only">Loading documentation…</span>
    </DocsPage>
  )
}
