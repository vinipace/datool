import { docsSource } from "@/lib/docs-source"
import { docsOrigin } from "@/lib/docs-origin"
import { getPublishedPages } from "@/lib/cms/content"
import { getPagePath } from "@/lib/cms/page-path"
import { cmsEnabled } from "@/lib/cms/config"

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
  const pages = await getPublishedPages()
  const urls = [
    ...(cmsEnabled() ? ["/", "/pricing"] : []),
    ...pages
      .filter((page) => !page.seo?.noIndex)
      .map((page) => getPagePath(page.slug))
      .filter((path) => !path.includes("#")),
    ...docsSource.getPages().map((page) => page.url),
  ].map((path) => `<url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`)
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
    {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    }
  )
}
