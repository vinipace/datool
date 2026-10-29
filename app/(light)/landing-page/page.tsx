import { notFound } from "next/navigation"
import { HomePage } from "@/components/cms/home-page"
import { getPublishedLanding } from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"
import { StructuredData } from "@/components/cms/structured-data"
import { websiteStructuredData } from "@/lib/cms/structured-data"

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
      <StructuredData data={websiteStructuredData()} />
      {page.layout[0]?.blockType !== "hero" && (
        <h1 className="pt-16 text-4xl font-semibold">{page.title}</h1>
      )}
      <HomePage blocks={page.layout} />
    </>
  )
}
