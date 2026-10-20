import { pageMetadata } from "@/lib/page-metadata"
import { SuggestionsPage } from "@/components/build/operations/suggestions-page"

export const metadata = pageMetadata("buildSuggestions")

export default async function BuildSuggestionsRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <SuggestionsPage />
}
