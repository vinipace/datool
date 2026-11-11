import { NextResponse } from "next/server"
import { accessError, apiError } from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { getProjectProviders } from "@/src/server/model-providers/store"

export const runtime = "nodejs"
type Context = { params: Promise<{ projectId: string }> }
const json = (value: unknown) =>
  NextResponse.json(value, { headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    return json({ providers: await getProjectProviders(projectId) })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load model providers.", 500)
  }
}

async function retired(request: Request, context: Context) {
  const { projectId } = await context.params
  const authorization = await requireProjectAccess(request, projectId)
  if (authorization.kind !== "ok") return accessError(authorization.kind)
  return apiError(
    "FORBIDDEN",
    "Manage providers in organization settings.",
    403
  )
}
export const PUT = retired
export const DELETE = retired
