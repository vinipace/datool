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
                  checked={
                    shopifySettings.requireHumanApproval ||
                    draft.toolSlug === "SHOPIFY_CREATE_EXCHANGE_ORDER"
                  }
                  disabled={draft.toolSlug === "SHOPIFY_CREATE_EXCHANGE_ORDER"}
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
            </>
          )}
        </>
      )}
    </div>
  )
}
