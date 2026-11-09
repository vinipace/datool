import { http, HttpResponse, delay } from "msw"
import type { AppConnection } from "@/src/lib/build/integrations"

export const connectionId = "e35e42aa-f025-4a7e-90af-bb53fe130d79"
export function appIntegrationScenario(
  initial:
    | "custom-mcp"
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
  let custom: AppConnection | null = null
  let connectAttempts = 0
  let actions: Array<Record<string, unknown>> = []
  const reset = () => {
    status =
      initial === "catalog" || initial === "shopify-active"
        ? "active"
        : initial === "active" || initial === "pending"
          ? initial
          : null
    custom =
      initial === "custom-mcp"
        ? {
            id: "mcp-fixture",
            toolkit: "custom_mcp",
            label: "Team knowledge",
            status: "active",
            mcpUrl: "https://knowledge.example.com/mcp",
            hasToken: true,
          }
        : null
    connectAttempts = 0
    actions = []
  }
  reset()
  return {
    reset,
    handlers: [
      http.post("*/api/build/:operation", async ({ params, request }) => {
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
              connections: [
                ...(custom ? [custom] : []),
                ...(status
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
                  : []),
              ],
            },
          })
        if (params.operation === "build_save_mcp_connection") {
          const input = (await request.json()) as {
            connectionId?: string
            name: string
            url?: string
            token?: string
          }
          custom = {
            id: input.connectionId ?? "mcp-fixture",
            toolkit: "custom_mcp",
            label: input.name,
            status: "active",
            mcpUrl: input.url ?? custom?.mcpUrl,
            hasToken:
              input.token === undefined
                ? custom?.hasToken
                : Boolean(input.token),
          }
          return HttpResponse.json({ data: custom })
        }
        if (
          params.operation === "build_refresh_app_connection" ||
          params.operation === "build_disconnect_app"
        ) {
          const input = (await request.clone().json()) as {
            connectionId: string
          }
          if (custom?.id === input.connectionId) {
            custom = {
              ...custom,
              status:
                params.operation === "build_disconnect_app"
                  ? "disconnected"
                  : "active",
            }
            return HttpResponse.json({ data: custom })
          }
        }
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
          return HttpResponse.json({ data: actions })
        if (params.operation === "build_save_action") {
          const input = (await request.json()) as {
            id: string
            slug: string
            agentId: string
            definition: Record<string, unknown>
          }
          const previous = actions.find((action) => action.id === input.id)
          const action = {
            ...input,
            projectId: "storybook-project",
            revision: previous ? Number(previous.revision) + 1 : 1,
            definition: {
              enabled: true,
              channels: [],
              procedureOnly: false,
              ...input.definition,
            },
          }
          actions = [...actions.filter((item) => item.id !== input.id), action]
          return HttpResponse.json({ data: action })
        }
        return HttpResponse.json({ data: {} })
      }),
    ],
  }
}
