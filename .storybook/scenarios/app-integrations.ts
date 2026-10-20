import { http, HttpResponse, delay } from "msw"
import type { AppConnection } from "@/src/lib/build/integrations"

export const connectionId = "e35e42aa-f025-4a7e-90af-bb53fe130d79"
export function appIntegrationScenario(
  initial:
    | "active"
    | "pending"
    | "empty"
    | "disabled"
    | "error"
    | "loading"
    | "catalog"
    | "connect-error" = "active"
) {
  let status: AppConnection["status"] | null = null
  let connectAttempts = 0
  const reset = () => {
    status =
      initial === "catalog"
        ? "active"
        : initial === "active" || initial === "pending"
          ? initial
          : null
    connectAttempts = 0
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
              apps: [
                { slug: "googlecalendar", name: "Google Calendar" },
                ...(initial === "catalog"
                  ? [
                      { slug: "slack", name: "Slack" },
                      { slug: "shopify", name: "Shopify" },
                      { slug: "zendesk", name: "Zendesk" },
                      { slug: "github", name: "GitHub" },
                      { slug: "notion", name: "Notion" },
                    ]
                  : []),
              ],
              connections: status
                ? [
                    {
                      id: connectionId,
                      toolkit: "googlecalendar",
                      label: "Google Calendar",
                      status,
                    },
                    ...(initial === "catalog"
                      ? [
                          {
                            id: "previous-attempt",
                            toolkit: "googlecalendar",
                            label: "Google Calendar",
                            status: "pending",
                          },
                          {
                            id: "slack-connection",
                            toolkit: "slack",
                            label: "Slack",
                            status: "pending",
                          },
                        ]
                      : []),
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
          if (initial === "connect-error" && connectAttempts++ === 0)
            return HttpResponse.json(
              { error: { message: "Unable to start authorization." } },
              { status: 503 }
            )
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
