import { pageMetadata } from "@/lib/page-metadata"
import { TestsPage } from "@/components/build/operations/tests-page"

export const metadata = pageMetadata("buildTests")

export default async function BuildTestsRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <TestsPage />
}
