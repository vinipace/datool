import type { Metadata } from "next"
import type { Page } from "@/payload-types"

export function cmsMetadata(
  doc: { title: string; seo?: Page["seo"] },
  path: string
): Metadata {
  const title = doc.seo?.title || doc.title
  const description = doc.seo?.description || undefined
  const url = new URL(
    path,
    process.env.BETTER_AUTH_URL || "http://localhost:3000"
  ).href
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: !doc.seo?.noIndex, follow: true },
    openGraph: { title, description, url, siteName: "Datool", type: "website" },
  }
}
