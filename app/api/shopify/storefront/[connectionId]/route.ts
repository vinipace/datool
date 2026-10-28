import { readJson } from "@/src/server/tracer/http"
import {
  publicConnectionContext,
  PublicAdmissionRateLimitError,
} from "@/src/server/build/channels/service"
import { challengeResponse } from "@/src/server/build/channels/challenge"
import { shopifyStorefrontSession } from "@/src/server/build/integrations/shopify-storefront"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  try {
    const { connectionId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const data = await shopifyStorefrontSession(
      build,
      connectionId,
      request,
      await readJson(request, 8 * 1024)
    )
    return Response.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }
    )
  } catch (error) {
    const challenge = challengeResponse(error)
    if (challenge) return challenge
    const limited = error instanceof PublicAdmissionRateLimitError
    return Response.json(
      {
        error: {
          message: limited
            ? error.message
            : "Could not verify your store session. Please refresh the page.",
        },
      },
      {
        status: limited ? 429 : 401,
        headers: {
          "Cache-Control": "no-store",
          ...(limited
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {}),
        },
      }
    )
  }
}
