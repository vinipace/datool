import { z } from "zod"
import { alertRoute, readAlertBody } from "@/src/server/alerts/http"
import {
  AlertInputError,
  deleteAlert,
  updateAlert,
  getAlert,
  alertWorkerOnline,
} from "@/src/server/alerts/service"

type Context = { params: Promise<{ projectId: string; alertId: string }> }
export async function GET(request: Request, context: Context) {
  const { projectId, alertId } = await context.params
  return alertRoute(request, projectId, async () => {
    const [alert, workerOnline] = await Promise.all([
      getAlert(projectId, alertId),
      alertWorkerOnline(),
    ])
    return Response.json({ alert, workerOnline })
  })
}
export async function PATCH(request: Request, context: Context) {
  const { projectId, alertId } = await context.params
  return alertRoute(request, projectId, async () => {
    const body = z
      .object({ revision: z.number().int().positive(), config: z.unknown() })
      .strict()
      .safeParse(await readAlertBody(request))
    if (!body.success)
      throw new AlertInputError("Provide the alert revision and configuration.")
    return Response.json({
      alert: await updateAlert(
        projectId,
        alertId,
        body.data.revision,
        body.data.config
      ),
    })
  })
}
export async function DELETE(request: Request, context: Context) {
  const { projectId, alertId } = await context.params
  return alertRoute(request, projectId, async () => {
    await deleteAlert(projectId, alertId)
    return Response.json({ deleted: true })
  })
}
