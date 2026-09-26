import { notFound, permanentRedirect } from "next/navigation"
import { ProductPillarPage } from "@/components/cms/product-page"
import { getPublishedPage } from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"
import {
  getProductFeature,
  getProductPillar,
  productFeatureHref,
  productPageSlug,
} from "@/lib/marketing/product"

export const dynamic = "force-dynamic"
type Props = { params: Promise<{ slug: string }> }
export async function generateMetadata({ params }: Props) {
  const { slug } = await params
  if (!getProductPillar(slug)) return {}
  const page = await getPublishedPage(productPageSlug(slug))
  return page ? cmsMetadata(page, `/product/${slug}`) : {}
}
export default async function FeaturePage({ params }: Props) {
  const { slug } = await params
  const legacyFeature = getProductFeature(slug)
  if (legacyFeature) permanentRedirect(productFeatureHref(legacyFeature))
  const pillar = getProductPillar(slug)
  if (!pillar) notFound()
  const page = await getPublishedPage(productPageSlug(slug))
  if (!page) notFound()
  // Existing editorial pages can reuse the published dashboard chapter until
  // their own dashboard blocks are added in the CMS.
  if (
    slug === "observe" &&
    !page.layout.some((block) => block.blockName === "dashboards")
  ) {
    const discover = await getPublishedPage(productPageSlug("discover"))
    const dashboardBlocks =
      discover?.layout.filter(
        (block) =>
          block.blockName === "dashboards" ||
          block.blockName === "dashboards-capabilities"
      ) ?? []
    return (
      <ProductPillarPage
        page={{ ...page, layout: [...page.layout, ...dashboardBlocks] }}
        pillar={pillar}
      />
    )
  }
  return <ProductPillarPage page={page} pillar={pillar} />
}
