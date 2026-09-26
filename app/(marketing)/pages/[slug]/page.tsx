import { notFound, permanentRedirect } from "next/navigation"
import { PageBlocks } from "@/components/cms/page-blocks"
import { getPublishedPage } from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"
import { getPagePath } from "@/lib/cms/page-path"

export const dynamic = "force-dynamic"
type Props = { params: Promise<{ slug: string }> }
export async function generateMetadata({ params }: Props) {
  const { slug } = await params
  const page = await getPublishedPage(slug)
  return page ? cmsMetadata(page, getPagePath(slug)) : {}
}
export default async function CustomPage({ params }: Props) {
  const { slug } = await params
  const legacyPath = getPagePath(slug)
  if (legacyPath.includes("#")) permanentRedirect(legacyPath)
  const page = await getPublishedPage(slug)
  if (!page) notFound()
  const path = getPagePath(page.slug)
  if (!path.startsWith("/pages/")) permanentRedirect(path)
  return (
    <>
      {page.layout[0]?.blockType !== "hero" && (
        <h1 className="pt-16 text-4xl font-semibold">{page.title}</h1>
      )}
      <PageBlocks blocks={page.layout} />
    </>
  )
}
