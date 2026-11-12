import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { getBuildContext } from "@/src/server/build/context"
import {
  deployProject,
  getDeployment,
  deploymentSummary,
} from "@/src/server/deploy/service"
import { deploymentMaxBytes } from "@/src/lib/deploy/contracts"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300
export const GET = workspaceRoute(async () => {
  const deployment = await getDeployment(getBuildContext())
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
