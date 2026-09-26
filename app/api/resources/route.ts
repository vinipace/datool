import { api, readJson } from "@/src/server/tracer/http"
import { z } from "zod"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams
  return api(request, (service) =>
    service.resources.export(
      z.enum(["dataset", "scorer"]).parse(query.get("kind")),
      z.string().min(1).parse(query.get("key"))
    )
  )
}
export async function POST(request: Request) {
  return api(
    request,
    async (service) => {
      const input = z
        .object({
          document: z.unknown(),
          expectedRevision: z.string().optional(),
          dryRun: z.boolean().default(false),
        })
        .parse(await readJson(request))
      return service.resources.push(
        input.document,
        input.expectedRevision,
        input.dryRun
      )
    },
    { mutation: true }
  )
}
