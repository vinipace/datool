import { http, HttpResponse, delay } from "msw"
import type { AppConnection } from "@/src/lib/build/integrations"

export const connectionId = "e35e42aa-f025-4a7e-90af-bb53fe130d79"
export function appIntegrationScenario(
  initial:
    "active" | "pending" | "empty" | "disabled" | "error" | "loading" = "active"
) {
  let status: AppConnection["status"] | null = null
  const reset = () => {
    status = initial === "active" || initial === "pending" ? initial : null
  }
  reset()
  return {
    reset,
    handlers: [
      http.post("*/api/build/:operation", async ({ params }) => {
        if (initial === "loading") await delay("infinite")
        if (initial === "error")
          return HttpResponse.json(
            { error: { message: "Unable to load app connections." } },
            { status: 503 }
          )
        if (params.operation === "build_list_app_connections")
          return HttpResponse.json({
            data: {
              configured: initial !== "disabled",
              apps: [{ slug: "googlecalendar", name: "Google Calendar" }],
              connections: status
                ? [
                    {
                      id: connectionId,
                      toolkit: "googlecalendar",
                      label: "Google Calendar",
                      status,
                    },
                  ]
                : [],
            },
          })
        if (params.operation === "build_list_app_tools")
          return HttpResponse.json({
            data: [
              {
                slug: "GOOGLECALENDAR_EVENTS_LIST",
                name: "List calendar events",
                description: "Look up scheduled events.",
                inputSchema: {
                  type: "object",
                  properties: { calendar_id: { type: "string" } },
                },
              },
            ],
          })
        if (params.operation === "build_connect_app") {
          status = "pending"
          return HttpResponse.json({
            data: {
              id: connectionId,
              redirectUrl: "https://connect.composio.dev/fixture",
            },
          })
        }
        if (params.operation === "build_refresh_app_connection")
          status = "active"
        if (params.operation === "build_disconnect_app") status = "disconnected"
        if (params.operation === "build_list_actions")
          return HttpResponse.json({ data: [] })
        return HttpResponse.json({ data: {} })
      }),
    ],
  }
}
