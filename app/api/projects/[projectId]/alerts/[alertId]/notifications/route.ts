import { z } from "zod"
import { alertRoute } from "@/src/server/alerts/http"
import { AlertInputError } from "@/src/server/alerts/service"
import { listAlertNotifications } from "@/src/server/alerts/notifications"

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; alertId: string }> }
) {
  const { projectId, alertId } = await context.params
  return alertRoute(request, projectId, async () => {
    const query = z
      .object({
        cursor: z.string().min(1).max(200).optional(),
        filter: z.string().max(2000).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        includeTotal: z.enum(["true", "false"]).optional(),
      })
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success)
      throw new AlertInputError("Invalid notification page parameters.")
    return Response.json(
      await listAlertNotifications(projectId, alertId, {
        ...query.data,
        includeTotal: query.data.includeTotal === "true",
      })
    )
  })
}
