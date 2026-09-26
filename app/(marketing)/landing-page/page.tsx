import { notFound } from "next/navigation"
import { PageBlocks } from "@/components/cms/page-blocks"
import { getPublishedLanding } from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"

export const dynamic = "force-dynamic"
export async function generateMetadata() {
  const page = await getPublishedLanding()
  return page ? cmsMetadata(page, "/") : {}
}
export default async function LandingPage() {
  const page = await getPublishedLanding()
  if (!page) notFound()
  return (
    <>
      {page.layout[0]?.blockType !== "hero" && (
        <h1 className="pt-16 text-4xl font-semibold">{page.title}</h1>
      )}
      <PageBlocks blocks={page.layout} landing />
    </>
  )
}
