import {
  getProductFeature,
  getProductPillar,
  productFeatureHref,
} from "@/lib/marketing/product"

export function getPagePath(slug: string) {
  if (slug.startsWith("product-")) {
    const name = slug.slice(8)
    if (getProductPillar(name)) return `/product/${name}`
    const feature = getProductFeature(name)
    if (feature) return productFeatureHref(feature)
  }
  return `/pages/${encodeURIComponent(slug)}`
}
