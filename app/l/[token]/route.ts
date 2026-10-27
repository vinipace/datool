import {
  publicLinkContext,
  resolveChannelLink,
} from "@/src/server/build/channels/links"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const context = await publicLinkContext(token)
    const destination =
      context && (await resolveChannelLink(context, token, request))
    return destination
      ? new Response(null, {
          status: 302,
          headers: { ...headers, Location: destination },
        })
      : new Response("Link unavailable.", { status: 404, headers })
  } catch {
    return new Response("Link temporarily unavailable.", {
      status: 503,
      headers: { ...headers, "Retry-After": "30" },
    })
  }
}
export const HEAD = GET
