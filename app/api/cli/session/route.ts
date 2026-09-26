import { authorizeProject, apiError } from "@/src/server/tracer/http"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    const { identity } = await authorizeProject(request)
    return Response.json(
      {
        data: {
          kind: identity.kind,
          projectId: identity.projectId,
          organizationId: identity.organizationId,
          scopes: identity.scopes,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}
