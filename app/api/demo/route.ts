import { api } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Explicit only: each request records a fresh live SDK workflow. */
export async function POST(request: Request) {
  return api(request, (service) => service.createDemo(), { mutation: true })
}
