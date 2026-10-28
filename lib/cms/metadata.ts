import type { Metadata } from "next"
import type { Page } from "@/payload-types"
import { socialPreviewImage } from "@/lib/page-metadata"
import { publicOrigin } from "@/lib/public-origin"

export function cmsMetadata(
  doc: { title: string; seo?: Page["seo"]; layout?: Page["layout"] },
  path: string
): Metadata {
  const savedTitle = doc.seo?.title || doc.title
  const title =
    path === "/" && savedTitle === "Understand and improve your AI"
      ? "AI Observability, Tracing & Evaluations"
      : savedTitle
  const hero = doc.layout?.find((block) => block.blockType === "hero")
  const description = doc.seo?.description || hero?.description || undefined
  const url = new URL(path, publicOrigin()).href
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: !doc.seo?.noIndex, follow: true },
    openGraph: {
      title,
      description,
      url,
      siteName: "Datool",
      type: "website",
      images: [socialPreviewImage],
    },
  }
}
