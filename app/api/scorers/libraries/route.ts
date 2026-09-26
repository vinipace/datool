import { Effect } from "effect"
import { api, readJson } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import {
  scorerLibraries,
  defaultLibraryMappings,
} from "@/src/lib/tracer/scorer-libraries"

export const runtime = "nodejs"
export async function GET(request: Request) {
  return api(request, () =>
    tracerEffect(async () => ({
      libraries: scorerLibraries,
      defaultMappings: defaultLibraryMappings,
    }))
  )
}

export async function POST(request: Request) {
  return api(
    request,
    async (service) => {
      const input = await readJson(request)
      return service.scorers
        .useLibrary(input)
        .pipe(Effect.flatMap((scorer) => service.getEvaluator(scorer.id)))
    },
    { mutation: true }
  )
}
