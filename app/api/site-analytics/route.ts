import { siteMeasurementId } from "@/lib/site-analytics-config"

export const dynamic = "force-dynamic"
export function GET() {
  return Response.json(
    { measurementId: siteMeasurementId() },
    { headers: { "Cache-Control": "no-store" } }
  )
}
