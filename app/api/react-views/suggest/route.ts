import { z } from "zod"
import { api, readJson } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import { validation } from "@/src/server/tracer/errors"
import { suggestViewRequirements } from "@/src/lib/tracer/react-view-suggestions"
export const runtime = "nodejs"
export function POST(request: Request) {
  return api(
    request,
    async () => {
      const input = z
        .object({
          code: z.string().max(100000),
          sample: z.record(z.string(), z.unknown()),
        })
        .strict()
        .safeParse(await readJson(request))
      if (!input.success)
        throw validation("Provide view code and a sample record.")
      return tracerEffect(async () =>
        suggestViewRequirements(input.data.code, input.data.sample)
      )
    },
    { mutation: true }
  )
}
