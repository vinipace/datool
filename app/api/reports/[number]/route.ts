import { api } from "@/src/server/tracer/http"
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(
  request: Request,
  context: { params: Promise<{ number: string }> }
) {
  const { number } = await context.params
  return api(request, (service) =>
    service.reports.get(/^[1-9]\d*$/.test(number) ? Number(number) : NaN)
  )
}
