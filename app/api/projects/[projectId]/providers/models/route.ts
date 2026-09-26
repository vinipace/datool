import { managedProjectAvailable } from "@/src/server/execution-credits/config"
import { NextResponse } from "next/server"
import { accessError, apiError } from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { getGatewayCatalog } from "@/src/server/model-providers/catalog"

export const runtime = "nodejs"
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    const datoolModel = await managedProjectAvailable(projectId, "model")
    const catalog = await getGatewayCatalog().catch((error) => {
      if (!datoolModel) throw error
      return { models: [], fetchedAt: new Date().toISOString(), stale: true }
    })
    return NextResponse.json(
      { ...catalog, datoolModel },
      {
        headers: { "Cache-Control": "no-store" },
      }
    )
  } catch {
    return apiError(
      "INTERNAL_ERROR",
      "Unable to load the model catalog. Try again shortly.",
      503
    )
  }
}
