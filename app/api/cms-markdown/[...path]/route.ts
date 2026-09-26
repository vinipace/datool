import config from "@payload-config"
import { cmsEnabled } from "@/lib/cms/config"
import { markdownNotFound, prefersMarkdown } from "@/lib/markdown-negotiation"
import {
  getPublishedLanding,
  getPublishedPage,
  getPublishedFAQPage,
  getPublishedFAQs,
  getPublishedFAQ,
  getFAQRelatedPages,
} from "@/lib/cms/content"
import { createCMSMarkdownRenderer } from "@/lib/cms/markdown"
import { getFAQPath } from "@/lib/cms/faq"
import { getPagePath } from "@/lib/cms/page-path"
import {
  getProductPillar,
  getProductFeature,
  productFeatureHref,
  productPageSlug,
} from "@/lib/marketing/product"

export const dynamic = "force-dynamic"

function markdownResponse(
  request: Request,
  markdown: string,
  path: string,
  noIndex?: boolean | null
) {
  const canonical = new URL(
    path,
    process.env.BETTER_AUTH_URL || "http://localhost:3000"
  ).href
  return new Response(markdown, {
    headers: {
      // Browsers download text/markdown instead of displaying it. Serve the
      // same Markdown as plain text by default, with the Markdown media type
      // available to clients that explicitly request it.
      "Content-Type": prefersMarkdown(request.headers.get("accept"))
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
      Vary: "Accept",
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Link: `<${canonical}>; rel="canonical"`,
      ...(noIndex ? { "X-Robots-Tag": "noindex, follow" } : {}),
    },
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!cmsEnabled()) return markdownNotFound()
  const { path } = await params
  const renderer = createCMSMarkdownRenderer(await config)
  if (path.length === 1 && path[0] === "landing-page") {
    const page = await getPublishedLanding()
    if (page)
      return markdownResponse(
        request,
        renderer.page(page),
        "/",
        page.seo?.noIndex
      )
  } else if (path.length === 2 && path[0] === "pages") {
    const destination = getPagePath(path[1])
    if (destination.includes("#"))
      return new Response(null, {
        status: 308,
        headers: { Location: `${destination.split("#")[0]}.md` },
      })
    const page = await getPublishedPage(path[1])
    if (page)
      return markdownResponse(
        request,
        renderer.page(page),
        getPagePath(page.slug),
        page.seo?.noIndex
      )
  } else if (
    path.length === 2 &&
    path[0] === "product" &&
    (getProductPillar(path[1]) || getProductFeature(path[1]))
  ) {
    const legacy = getProductFeature(path[1])
    if (legacy) {
      const destination = productFeatureHref(legacy).split("#")[0]
      return new Response(null, {
        status: 308,
        headers: { Location: `${destination}.md` },
      })
    }
    const page = await getPublishedPage(productPageSlug(path[1]))
    if (page)
      return markdownResponse(
        request,
        renderer.page(page),
        getPagePath(page.slug),
        page.seo?.noIndex
      )
  } else if (path.length === 1 && path[0] === "faq") {
    const [page, faqs] = await Promise.all([
      getPublishedFAQPage(),
      getPublishedFAQs(),
    ])
    if (page)
      return markdownResponse(
        request,
        renderer.faqIndex(page, faqs),
        "/faq",
        page.seo?.noIndex
      )
  } else if (path.length === 2 && path[0] === "faq") {
    const faq = await getPublishedFAQ(path[1])
    if (faq)
      return markdownResponse(
        request,
        renderer.faqAnswer(faq, await getFAQRelatedPages(faq.id)),
        getFAQPath(faq.slug),
        faq.seo?.noIndex
      )
  }
  if (prefersMarkdown(request.headers.get("accept"))) return markdownNotFound()
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Accept",
    },
  })
}
