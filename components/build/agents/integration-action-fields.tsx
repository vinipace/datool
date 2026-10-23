"use client"

import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { FormRow } from "@/components/ui/form-row"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { shopifyActionSettingsSchema } from "@/src/lib/build/shopify"
import { useRemote } from "@/components/tracer/hooks"
import { buildApi } from "@/components/build/operations/build-api"
import type { ActionDefinition } from "@/src/lib/build/contracts"
import type {
  IntegrationCatalog,
  IntegrationTool,
} from "@/src/lib/build/integrations"

type Definition = Extract<ActionDefinition, { type: "integration" }>
export function IntegrationActionFields({
  draft,
  onChange,
  onManageIntegrations,
}: {
  draft: Definition
  onChange: (value: Definition) => void
  onManageIntegrations: () => void
}) {
  const connections = useRemote(
    (signal) =>
      buildApi.call<IntegrationCatalog>(
        "build_list_app_connections",
        {},
        signal
      ),
    []
  )
  const selected = connections.data?.connections.find(
    (item) => item.id === draft.connectionId
  )
  const shopifySettings = shopifyActionSettingsSchema.parse(
    draft.shopifySettings ?? {}
  )
  const tools = useRemote(
    (signal) =>
      buildApi.call<IntegrationTool[]>(
        "build_list_app_tools",
        { connectionId: draft.connectionId },
        signal
      ),
    [draft.connectionId, selected?.status],
    { enabled: selected?.status === "active" }
  )
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground-muted">
        Choose a connected account and the action this agent can use.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onManageIntegrations}
      >
        Manage integrations
      </Button>
      {connections.isLoading ? (
        <div role="status" aria-label="Loading app connections">
          <Skeleton className="h-20" />
        </div>
      ) : connections.error ? (
        <Notice variant="error" role="alert">
          {connections.error.message}{" "}
          <Button size="sm" variant="outline" onClick={connections.refresh}>
            Retry connections
          </Button>
        </Notice>
      ) : !connections.data?.configured ? (
        <Notice>
          App integrations need administrator setup before you can connect an
          account.
        </Notice>
      ) : (
        <>
          <FormRow
            label="Connected account"
            htmlFor="integration-connection"
            layout="vertical"
            variant="plain"
          >
            <Select
              id="integration-connection"
              value={draft.connectionId}
              onChange={(event) => {
                onChange({
                  ...draft,
                  connectionId: event.target.value,
                  toolSlug: "",
                  inputSchema: {},
                })
              }}
            >
              <option value="">Choose a connected account…</option>
              {connections.data.connections.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={item.status !== "active"}
                >
                  {item.label} · {item.status} · {item.id.slice(0, 6)}
                </option>
              ))}
            </Select>
          </FormRow>
          {!connections.data.connections.some(
            (item) => item.status === "active"
          ) ? (
            <Notice>
              Connect an account in Integrations before choosing an app action.
            </Notice>
          ) : selected && selected.status !== "active" ? (
            <Notice>Refresh or reconnect this account in Integrations.</Notice>
          ) : null}
          {selected?.status === "active" && (
            <FormRow
              label="App action"
              htmlFor="integration-tool"
              layout="vertical"
              variant="plain"
            >
              <Select
                id="integration-tool"
                value={draft.toolSlug}
                disabled={tools.isLoading}
                onChange={(event) => {
                  const tool = tools.data?.find(
                    (item) => item.slug === event.target.value
                  )
                  if (tool)
                    onChange({
                      ...draft,
                      toolSlug: tool.slug,
                      name: draft.name || tool.name.slice(0, 160),
                      description: tool.description.slice(0, 2000),
                      inputSchema:
                        tool.inputSchema as Definition["inputSchema"],
                    })
                }}
              >
                <option value="">
                  {tools.isLoading ? "Loading actions…" : "Choose an action…"}
                </option>
                {tools.data?.map((tool) => (
                  <option key={tool.slug} value={tool.slug}>
                    {tool.name}
                  </option>
                ))}
              </Select>
              {tools.data?.length === 0 && (
                <p className="text-sm text-foreground-muted">
                  No enabled actions are available for this account.
                </p>
              )}
            </FormRow>
          )}
          {tools.error && (
            <Notice variant="error" role="alert">
              {tools.error.message}{" "}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={tools.refresh}
              >
                Retry actions
              </Button>
            </Notice>
          )}
          {selected?.toolkit === "shopify_native" && draft.toolSlug && (
            <>
              <FormRow
                label="Require teammate approval"
                htmlFor="shopify-human-approval"
                description="Pause this action until a teammate approves it in Inbox."
                layout="vertical"
                variant="plain"
              >
                <Switch
                  id="shopify-human-approval"
                  checked={shopifySettings.requireHumanApproval}
                  onCheckedChange={(requireHumanApproval) =>
                    onChange({
                      ...draft,
                      shopifySettings: {
                        ...shopifySettings,
                        requireHumanApproval,
                      },
                    })
                  }
                />
              </FormRow>
              {draft.toolSlug === "SHOPIFY_RETURN_OR_EXCHANGE" && (
                <>
                  <FormRow
                    label="Return window (days)"
                    htmlFor="shopify-return-window"
                    description="Days after delivery. Leave empty for no time limit. Orders without a confirmed delivery date need store-team review when a window is set."
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="shopify-return-window"
                      type="number"
                      min={1}
                      max={365}
                      defaultValue={shopifySettings.returnWindowDays ?? ""}
                      onBlur={(event) => {
                        const value = event.currentTarget.value.trim()
                        const parsed = shopifyActionSettingsSchema.safeParse({
                          ...shopifySettings,
                          returnWindowDays: value ? Number(value) : null,
                        })
                        if (parsed.success)
                          onChange({ ...draft, shopifySettings: parsed.data })
                        else
                          event.currentTarget.value = String(
                            shopifySettings.returnWindowDays ?? ""
                          )
                      }}
                    />
                  </FormRow>
                  <FormRow
                    label="Allow exchanges"
                    htmlFor="shopify-allow-exchanges"
                    description="Let shoppers choose replacement items on the original order. Additional balances must be paid before replacement fulfillment."
                    layout="vertical"
                    variant="plain"
                  >
                    <Switch
                      id="shopify-allow-exchanges"
                      checked={shopifySettings.allowExchanges}
                      onCheckedChange={(allowExchanges) =>
                        onChange({
                          ...draft,
                          shopifySettings: {
                            ...shopifySettings,
                            allowExchanges,
                          },
                        })
                      }
                    />
                  </FormRow>
                </>
              )}
              {draft.toolSlug === "SHOPIFY_SEARCH_PRODUCTS" && (
                <FormRow
                  label="Exclude out-of-stock products"
                  htmlFor="shopify-exclude-stock"
                  description="Only show products with an available variant. Prices and availability are read live from Shopify. Enable one Update shopping cart action for this store and channel to add cart buttons to product cards."
                  layout="vertical"
                  variant="plain"
                >
                  <Switch
                    id="shopify-exclude-stock"
                    checked={shopifySettings.excludeOutOfStock}
                    onCheckedChange={(excludeOutOfStock) =>
                      onChange({
                        ...draft,
                        shopifySettings: {
                          ...shopifySettings,
                          excludeOutOfStock,
                        },
                      })
                    }
                  />
                </FormRow>
              )}
              {draft.toolSlug === "SHOPIFY_TAG_ORDER" && (
                <FormRow
                  label="Allowed order tags"
                  htmlFor="shopify-allowed-tags"
                  description="Separate tags with commas. The agent can only add these tags to the customer's own orders."
                  layout="vertical"
                  variant="plain"
                >
                  <Input
                    id="shopify-allowed-tags"
                    key={`${draft.id}:${draft.connectionId}`}
                    defaultValue={shopifySettings.allowedOrderTags.join(", ")}
                    onBlur={(event) =>
                      onChange({
                        ...draft,
                        shopifySettings: {
                          ...shopifySettings,
                          allowedOrderTags: event.target.value
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </FormRow>
              )}
              {draft.toolSlug === "SHOPIFY_CREATE_ORDER" && (
                <>
                  {(
                    [
                      {
                        key: "paymentMethod",
                        label: "Payment",
                        description:
                          "Online payment creates a checkout link. Cash on delivery places an unpaid order. Free orders waive the full price and delivery charge; use a controlled procedure or teammate approval for gifts and replacements.",
                        options: [
                          ["online", "Online payment"],
                          ["cash_on_delivery", "Cash on delivery"],
                          ["free", "Free order"],
                        ],
                      },
                      {
                        key: "orderSource",
                        label: "Order items",
                        description:
                          "Use the current storefront cart, or the specific items selected in this conversation.",
                        options: [
                          ["cart", "Use the cart"],
                          ["items", "Specific items"],
                        ],
                      },
                      {
                        key: "shippingPhone",
                        label: "Delivery phone",
                        description:
                          "Choose whether a delivery phone number must be collected.",
                        options: [
                          ["required", "Required"],
                          ["optional", "Optional"],
                          ["omit", "Do not include"],
                        ],
                      },
                    ] as const
                  ).map((field) => (
                    <FormRow
                      key={field.key}
                      label={field.label}
                      htmlFor={`shopify-${field.key}`}
                      description={field.description}
                      layout="vertical"
                      variant="plain"
                    >
                      <Select
                        id={`shopify-${field.key}`}
                        value={shopifySettings[field.key]}
                        onChange={(event) =>
                          onChange({
                            ...draft,
                            shopifySettings: shopifyActionSettingsSchema.parse({
                              ...shopifySettings,
                              [field.key]: event.target.value,
                            }),
                          })
                        }
                      >
                        {field.options.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    </FormRow>
                  ))}
                  <FormRow
                    label="Order tags"
                    htmlFor="shopify-order-tags"
                    description="Separate tags with commas. These are applied to every order created by this action."
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="shopify-order-tags"
                      key={`${draft.id}:${draft.connectionId}:order-tags`}
                      defaultValue={shopifySettings.orderTags.join(", ")}
                      onBlur={(event) =>
                        onChange({
                          ...draft,
                          shopifySettings: {
                            ...shopifySettings,
                            orderTags: event.target.value
                              .split(",")
                              .map((tag) => tag.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </FormRow>
                  <FormRow
                    label="Order note"
                    htmlFor="shopify-order-note"
                    description="A note for the store team. Use {{paymentModeLabel}} to include the payment method."
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="shopify-order-note"
                      maxLength={1000}
                      value={shopifySettings.orderNote}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          shopifySettings: {
                            ...shopifySettings,
                            orderNote: event.target.value,
                          },
                        })
                      }
                    />
                  </FormRow>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
