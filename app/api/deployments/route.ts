import { parseEnvironment } from "@/src/server/deploy/context"
import { ZodError } from "zod"
import { TracerError } from "@/src/server/tracer/errors"
import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { getBuildContext } from "@/src/server/build/context"
import {
  deployProject,
  getDeployment,
  deploymentSummary,
  readDeploymentView,
} from "@/src/server/deploy/service"
import { deploymentMaxBytes } from "@/src/lib/deploy/contracts"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300
export const GET = workspaceRoute(async (request) => {
  const parameters = new URL(request.url).searchParams
  if (parameters.has("view")) {
    try {
      return Response.json(
        { data: await readDeploymentView(getBuildContext(), parameters) },
        { headers: { "Cache-Control": "no-store" } }
      )
    } catch (error) {
      if (error instanceof ZodError)
        throw new TracerError(
          "VALIDATION_ERROR",
          "Invalid deployment view request."
        )
      throw error
    }
  }
  const deployment = await getDeployment({
    ...getBuildContext(),
    environment: parseEnvironment(parameters.get("environment")),
  })
  return Response.json(
    { data: deployment ? deploymentSummary(deployment) : null },
    { headers: { "Cache-Control": "no-store" } }
  )
})
export const POST = workspaceRoute(async (request) => {
  const data = await deployProject(
    getBuildContext(),
    await readJson(request, deploymentMaxBytes),
    request.signal
  )
  return Response.json({ data }, { headers: { "Cache-Control": "no-store" } })
})
