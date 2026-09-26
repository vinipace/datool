import { NextResponse, type NextRequest } from "next/server"
import {
  docsMarkdownPath,
  markdownNotFound,
  prefersMarkdown,
  publicMarkdownPath,
} from "@/lib/markdown-negotiation"
import { cmsEnabled } from "@/lib/cms/config"

/** Preserve the requested deep link across authentication and organization selection. */
export function proxy(request: NextRequest) {
  // Stop before streaming starts: a page/layout notFound() can otherwise retain
  // HTTP 200 after its parent has flushed the response headers.
  if (
    !cmsEnabled() &&
    /^\/(?:cms|cms-preview|landing-page|faq|pages|product|pricing)(?:\/|\.md$|$)/.test(
      request.nextUrl.pathname
    )
  ) {
    return prefersMarkdown(request.headers.get("accept"))
      ? markdownNotFound()
      : new NextResponse("Not found\n", {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
            "X-Robots-Tag": "noindex, nofollow",
          },
        })
  }
  const requestHeaders = new Headers(request.headers)
  const search = new URLSearchParams(request.nextUrl.searchParams)
  search.delete("_rsc")
  const query = search.toString()
  // Overwrite client input: this header is only a server-derived return location.
  requestHeaders.set(
    "x-datool-workspace-path",
    `${request.nextUrl.pathname}${query ? `?${query}` : ""}`
  )
  const markdown =
    ["GET", "HEAD"].includes(request.method) &&
    (prefersMarkdown(request.headers.get("accept")) ||
      (request.nextUrl.pathname.endsWith(".md") &&
        docsMarkdownPath(request.nextUrl.pathname) !== null))
  // Used only by the fallback rewrite, after Next has exhausted real routes.
  requestHeaders.set("x-datool-markdown", markdown ? "1" : "0")
  const destination = markdown
    ? publicMarkdownPath(request.nextUrl.pathname)
    : null
  const response = destination
    ? NextResponse.rewrite(new URL(destination, request.url), {
        request: { headers: requestHeaders },
      })
    : NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.append("Vary", "Accept")
  if (
    !markdown &&
    ["GET", "HEAD"].includes(request.method) &&
    docsMarkdownPath(request.nextUrl.pathname)
  ) {
    // Next's prerendered HTML replaces Vary, dropping Accept. Keep the static
    // render, but prevent downstream caches from serving HTML to Markdown reads.
    response.headers.set("Cache-Control", "no-store")
  }
  return response
}

export const config = {
  matcher: ["/((?!api/|api$|_next/|\\.well-known/|favicon.ico$).*)"],
}
