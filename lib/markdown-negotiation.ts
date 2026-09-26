/** Prefer explicit HTML on ties; wildcards alone never opt into Markdown. */
export function prefersMarkdown(accept: string | null) {
  const ranges = (accept ?? "").split(",").map((range) => {
    const [type, ...parameters] = range.trim().toLowerCase().split(";")
    const quality = parameters.find((parameter) =>
      parameter.trim().startsWith("q=")
    )
    const value = quality?.trim().slice(2) ?? "1"
    return {
      type: type.trim(),
      q: /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0,
    }
  })
  const markdown = ranges.find(({ type }) => type === "text/markdown")?.q ?? 0
  const html =
    (
      ranges.find(({ type }) => type === "text/html") ??
      ranges.find(({ type }) => type === "text/*") ??
      ranges.find(({ type }) => type === "*/*")
    )?.q ?? 0
  const explicitHtml = ranges.some(({ type }) => type === "text/html")
  return (
    markdown > 0 && (markdown > html || (markdown === html && !explicitHtml))
  )
}

/** Map public docs URLs and .md aliases to the Markdown handler. */
export function docsMarkdownPath(pathname: string) {
  const path = pathname.replace(/\/$/, "").replace(/\.md$/, "")
  if (path === "/docs") return "/api/docs-markdown"
  if (path.startsWith("/docs/"))
    return `/api/docs-markdown${path.slice("/docs".length)}`
  return null
}

/** Only published public content has alternate representations. */
export function publicMarkdownPath(pathname: string) {
  const docs = docsMarkdownPath(pathname)
  if (docs) return docs
  if (pathname.endsWith(".md")) return null
  if (pathname === "/" || pathname === "/landing-page")
    return "/api/cms-markdown/landing-page"
  if (
    /^\/(?:pages|product)\/[^/]+$/.test(pathname) ||
    /^\/faq(?:\/[^/]+)?$/.test(pathname)
  )
    return `/api/cms-markdown${pathname}`
  return null
}

export function markdownNotFound() {
  return new Response(
    "# Page not found\n\nThe requested public page does not exist or is not published. Check the URL and use the [documentation](/docs), [sitemap](/sitemap.xml), or [agent index](/llms.txt) to find available content.\n",
    {
      status: 404,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        Vary: "Accept",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, follow",
      },
    }
  )
}
