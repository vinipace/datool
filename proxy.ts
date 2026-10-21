import { NextResponse, type NextRequest } from "next/server"
import {
  docsMarkdownPath,
  markdownNotFound,
  prefersMarkdown,
  publicMarkdownPath,
} from "@/lib/markdown-negotiation"
import { cmsEnabled } from "@/lib/cms/config"
import { buildEnabled } from "@/lib/build/config"

const publicChatPath = /^\/chat\/([^/]+)\/?$/

function publicChatConnectionId(pathname: string) {
  const match = publicChatPath.exec(pathname)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

async function applyPublicChatPolicy(
  request: NextRequest,
  response: NextResponse
) {
  const connectionId = publicChatConnectionId(request.nextUrl.pathname)
  if (!connectionId) return response

  try {
    const { getPublicChatFramePolicy } =
      await import("@/src/server/build/channels/service")
    const policy = await getPublicChatFramePolicy(connectionId)
    response.headers.set(
      "Content-Security-Policy",
      policy.contentSecurityPolicy
    )
  } catch {
    // A missing, disconnected, or unavailable connection must never become
    // embeddable while the policy lookup is unavailable.
    response.headers.set("Content-Security-Policy", "frame-ancestors 'none'")
  }
  return response
}

/** Preserve the requested deep link across authentication and organization selection. */
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const buildApi = /^\/api\/build(?:-public|-webhooks)?(?:\/|$)/.test(pathname)
  if (
    !buildEnabled() &&
    (buildApi || /^\/(?:p\/[^/]+\/build|chat)(?:\/|$)/.test(pathname))
  ) {
    const headers = {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    }
    return buildApi
      ? NextResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Build is disabled on this installation.",
            },
          },
          { status: 404, headers }
        )
      : new NextResponse("Not found\n", {
          status: 404,
          headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
        })
  }
  if (buildApi) return NextResponse.next()
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
  if (request.nextUrl.pathname.startsWith("/share/reports/")) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0")
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive")
    response.headers.set("Referrer-Policy", "no-referrer")
  }
  if (
    !markdown &&
    ["GET", "HEAD"].includes(request.method) &&
    docsMarkdownPath(request.nextUrl.pathname)
  ) {
    // Next's prerendered HTML replaces Vary, dropping Accept. Keep the static
    // render, but prevent downstream caches from serving HTML to Markdown reads.
    response.headers.set("Cache-Control", "no-store")
  }
  return publicChatConnectionId(request.nextUrl.pathname)
    ? (applyPublicChatPolicy(request, response) as unknown as NextResponse)
    : response
}

export const config = {
  matcher: [
    "/api/build/:path*",
    "/api/build-public/:path*",
    "/api/build-webhooks/:path*",
    "/((?!api/|api$|_next/|\\.well-known/|favicon.ico$).*)",
  ],
}
