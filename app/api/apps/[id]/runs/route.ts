import { api, readJson } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import { validation } from "@/src/server/tracer/errors"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import {
  prepareAppScoring,
  runAppExperiment,
  selectedScorers,
} from "@/src/server/apps/scoring"
import { resolveApp, validateAppInput } from "@/src/server/apps/invoke"

export const runtime = "nodejs"
export const maxDuration = 120

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return api(
    request,
    (service) =>
      tracerEffect(async () => {
        const { id } = await context.params
        const app = await resolveApp(id)
        const input = await readJson(request)
        try {
          validateAppInput(app, input)
        } catch (error) {
          throw validation((error as Error).message)
        }
        const scorerIds = selectedScorers(
          new URL(request.url).searchParams.get("scorers"),
          app.definition.evaluatorIds
        )
        const versions = await prepareAppScoring(service, scorerIds)
        const { experiment, trace: result } = await runAppExperiment(
          service,
          app,
          input as JsonValue,
          versions
        )
        return {
          evalRunId: experiment.id,
          traceId: result.id,
          status: result.status,
          output: result.output,
          error:
            result.status === "errored"
              ? result.attributes["error.message"]
              : undefined,
        }
      }),
    { mutation: true }
  )
}
