import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { listApps, registerApps } from "@/src/server/apps/catalog"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const GET = workspaceRoute(async () =>
  Response.json({ data: await listApps() })
)
export const POST = workspaceRoute(async (request) => {
  try {
    return Response.json({ data: await registerApps(await readJson(request)) })
  } catch (error) {
    return Response.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Unable to register app.",
        },
      },
      { status: 400 }
    )
  }
})
