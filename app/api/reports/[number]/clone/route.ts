import { api, readJson } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function POST(
  request: Request,
  context: { params: Promise<{ number: string }> }
) {
  const { number } = await context.params
  return api(
    request,
    async (service) => {
      const body = await readJson(request)
      return service.reports.clone({
        ...(body && typeof body === "object" ? body : {}),
        number: /^[1-9]\d*$/.test(number) ? Number(number) : NaN,
      })
    },
    { mutation: true }
  )
}
