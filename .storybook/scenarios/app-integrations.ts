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
    | "shopify"
    | "shopify-active"
    | "shopify-unconfigured"
    | "connect-error" = "active"
) {
  let status: AppConnection["status"] | null = null
  let connectAttempts = 0
  const reset = () => {
    status =
      initial === "catalog" || initial === "shopify-active"
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
              apps: initial.startsWith("shopify")
                ? [
                    {
                      slug: "shopify_native",
                      name: "Shopify",
                      connectionMethod: "shopify",
                      available: initial !== "shopify-unconfigured",
                    },
                  ]
                : [
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
                      toolkit: initial.startsWith("shopify")
                        ? "shopify_native"
                        : "googlecalendar",
                      label: initial.startsWith("shopify")
                        ? "sample.myshopify.com"
                        : "Google Calendar",
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
            data:
              initial === "shopify-active"
                ? [
                    {
                      slug: "SHOPIFY_SEARCH_PRODUCTS",
                      name: "Search products",
                      description: "Show live store products.",
                      inputSchema: {},
                    },
                    {
                      slug: "SHOPIFY_TAG_ORDER",
                      name: "Tag an order",
                      description:
                        "Apply allowed tags to the customer's order.",
                      inputSchema: {},
                    },
                    {
                      slug: "SHOPIFY_RETURN_OR_EXCHANGE",
                      name: "Return or exchange items",
                      description:
                        "Prepare a return or exchange for confirmation.",
                      inputSchema: {},
                    },
                    {
                      slug: "SHOPIFY_CREATE_ORDER",
                      name: "Create order",
                      description: "Prepare an order for confirmation.",
                      inputSchema: {},
                    },
                    {
                      slug: "SHOPIFY_CREATE_EXCHANGE_ORDER",
                      name: "Create replacement exchange",
                      description:
                        "Prepare a replacement exchange for mandatory teammate approval.",
                      inputSchema: {},
                    },
                  ]
                : [
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
          if (initial !== "shopify") status = "pending"
          return HttpResponse.json({
            data: {
              id: connectionId,
              redirectUrl:
                initial === "shopify"
                  ? "https://datool.example/api/shopify/install?intent=fixture"
                  : "https://connect.composio.dev/fixture",
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
