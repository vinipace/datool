import { docsSource } from "@/lib/docs-source"
import { docsOrigin } from "@/lib/docs-origin"
import {
  getPublishedPages,
  getPublishedFAQPage,
  getPublishedFAQs,
} from "@/lib/cms/content"
import { getFAQPath } from "@/lib/cms/faq"
import { getPagePath } from "@/lib/cms/page-path"
import { cmsEnabled } from "@/lib/cms/config"
import {
  agentLandingPath,
  agentLandingSlugs,
} from "@/cms/agent-landing-content"

// Deployment origins are runtime configuration, including in the Docker image.
export const dynamic = "force-dynamic"

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll(">", "&gt;")
}

export async function GET(request: Request) {
  const origin = docsOrigin(request)
  const [pages, faqPage, faqs] = await Promise.all([
    getPublishedPages(),
    getPublishedFAQPage(),
    getPublishedFAQs(),
  ])
  const paths = [
    ...(cmsEnabled()
      ? ["/", "/pricing", ...agentLandingSlugs.map(agentLandingPath)]
      : []),
    ...(faqPage && !faqPage.seo?.noIndex ? ["/faq"] : []),
    ...faqs
      .filter((faq) => !faq.seo?.noIndex)
      .map((faq) => getFAQPath(faq.slug)),
    ...pages
      .filter((page) => !page.seo?.noIndex)
      .map((page) => getPagePath(page.slug))
      .filter((path) => !path.includes("#")),
    ...docsSource.getPages().map((page) => page.url),
  ]
  const urls = [...new Set(paths)].map(
    (path) => `<url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`
  )
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
    {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    }
  )
}
