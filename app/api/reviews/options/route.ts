import { api } from "@/src/server/tracer/http"
export const runtime = "nodejs"
export async function GET(request: Request) {
  return api(request, (service) => service.reviews.options())
}
