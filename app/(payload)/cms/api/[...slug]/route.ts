/* THIS FILE FOLLOWS PAYLOAD'S GENERATED APP ROUTER SHELL. */
import config from "@payload-config"
import { cmsEnabled } from "@/lib/cms/config"
import "@payloadcms/next/css"
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes"

export const dynamic = "force-dynamic"

function whenEnabled(handler: ReturnType<typeof REST_GET>) {
  return (...args: Parameters<typeof handler>) =>
    cmsEnabled()
      ? handler(...args)
      : new Response(null, {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        })
}

export const GET = whenEnabled(REST_GET(config))
// Payload dispatches by request.method; Next's implicit HEAD otherwise returns 404.
export async function HEAD(request: Request, args: Parameters<typeof GET>[1]) {
  const response = await GET(
    new Request(request.url, {
      method: "GET",
      headers: request.headers,
      signal: request.signal,
    }),
    args
  )
  await response.body?.cancel()
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
export const POST = whenEnabled(REST_POST(config))
export const DELETE = whenEnabled(REST_DELETE(config))
export const PATCH = whenEnabled(REST_PATCH(config))
export const PUT = whenEnabled(REST_PUT(config))
export const OPTIONS = whenEnabled(REST_OPTIONS(config))
