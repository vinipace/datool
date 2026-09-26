import { api } from "@/src/server/tracer/http"
export const runtime = "nodejs"
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params
  const version = new URL(request.url).searchParams.get("version")
  return api(request, (service) =>
    service.prompts.get(
      slug,
      true,
      version === null ? undefined : Number(version)
    )
  )
}
