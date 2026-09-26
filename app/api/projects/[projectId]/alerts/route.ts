import { alertRoute, readAlertBody } from "@/src/server/alerts/http"
import { createAlert, listAlerts } from "@/src/server/alerts/service"

type Context = { params: Promise<{ projectId: string }> }
export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params
  return alertRoute(request, projectId, async () =>
    Response.json(await listAlerts(projectId))
  )
}
export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params
  return alertRoute(request, projectId, async () =>
    Response.json(
      { alert: await createAlert(projectId, await readAlertBody(request)) },
      { status: 201 }
    )
  )
}
