"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { FormRow } from "@/components/ui/form-row"
import { Skeleton } from "@/components/ui/skeleton"
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
}: {
  draft: Definition
  onChange: (value: Definition) => void
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
  const [app, setApp] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [authorization, setAuthorization] = React.useState<string | null>(null)
  const selected = connections.data?.connections.find(
    (item) => item.id === draft.connectionId
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
  async function run(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to update the app connection."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground-muted">
        Connect an app, then choose the action this agent can use. Connections
        are shared within this project. App calls and connection attempts may
        use your organization’s execution credits.
      </p>
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
            label="Connect an app"
            htmlFor="integration-app"
            layout="vertical"
            variant="plain"
          >
            <div className="flex flex-wrap gap-2">
              <Select
                id="integration-app"
                value={app}
                onChange={(event) => setApp(event.target.value)}
                className="min-w-0 flex-1"
              >
                <option value="">Choose an app…</option>
                {connections.data.apps.map((item) => (
                  <option key={item.slug} value={item.slug}>
                    {item.name}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={!app}
                loading={pending}
                onClick={() =>
                  run(async () => {
                    const result = await buildApi.call<{
                      id: string
                      redirectUrl: string
                    }>("build_connect_app", { toolkit: app })
                    setAuthorization(result.redirectUrl)
                    onChange({
                      ...draft,
                      connectionId: result.id,
                      toolSlug: "",
                      inputSchema: {},
                    })
                    connections.refresh()
                  })
                }
              >
                Connect
              </Button>
            </div>
          </FormRow>
          {authorization && (
            <Notice>
              <a
                className="underline"
                href={authorization}
                target="_blank"
                rel="noopener noreferrer"
              >
                Authorize the app in a new tab
              </a>
              , then return here and refresh the connection.
            </Notice>
          )}
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
                setAuthorization(null)
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
                <option key={item.id} value={item.id}>
                  {item.label} · {item.status} · {item.id.slice(0, 6)}
                </option>
              ))}
            </Select>
          </FormRow>
          {selected && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={pending}
                onClick={() =>
                  run(async () => {
                    await buildApi.call("build_refresh_app_connection", {
                      connectionId: selected.id,
                    })
                    connections.refresh()
                    tools.refresh()
                  })
                }
              >
                Refresh connection
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={pending}
                onClick={() =>
                  run(async () => {
                    if (
                      !window.confirm(
                        "Disconnect this account for every agent in this project?"
                      )
                    )
                      return
                    try {
                      await buildApi.call("build_disconnect_app", {
                        connectionId: selected.id,
                      })
                    } finally {
                      connections.refresh()
                    }
                    setAuthorization(null)
                  })
                }
              >
                Disconnect
              </Button>
            </div>
          )}
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
        </>
      )}
      {error && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
    </div>
  )
}
