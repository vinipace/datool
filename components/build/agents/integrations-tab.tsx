"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { FormRow } from "@/components/ui/form-row"
import { Skeleton } from "@/components/ui/skeleton"
import { useRemote } from "@/components/tracer/hooks"
import { buildApi } from "@/components/build/operations/build-api"
import type { IntegrationCatalog } from "@/src/lib/build/integrations"

export function IntegrationsTab({ active = true }: { active?: boolean }) {
  const [selectedId, setSelectedId] = React.useState("")
  const connections = useRemote(
    (signal) =>
      buildApi.call<IntegrationCatalog>(
        "build_list_app_connections",
        {},
        signal
      ),
    [],
    { enabled: active }
  )
  const [app, setApp] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [authorization, setAuthorization] = React.useState<string | null>(null)
  const selected = connections.data?.connections.find(
    (item) => item.id === selectedId
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
    <section
      aria-label="App integrations"
      className="w-full min-w-0 px-4 py-6 sm:px-6"
    >
      <div className="max-w-xl space-y-4">
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-foreground-muted">
          Connect and manage the apps your agent can use. Connections are shared
          within this project. Choose the tools available to this agent in
          Actions. App calls and connection attempts may use your organization’s
          execution credits.
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
              htmlFor="agent-integration-app"
              layout="vertical"
              variant="plain"
            >
              <div className="flex flex-wrap gap-2">
                <Select
                  id="agent-integration-app"
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
                      setSelectedId(result.id)
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
              htmlFor="agent-integration-connection"
              layout="vertical"
              variant="plain"
            >
              <Select
                id="agent-integration-connection"
                value={selectedId}
                onChange={(event) => {
                  setAuthorization(null)
                  setSelectedId(event.target.value)
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
            {connections.data.connections.length === 0 && (
              <Notice>
                No apps connected. Choose an app above to get started.
              </Notice>
            )}
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
          </>
        )}
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
      </div>
    </section>
  )
}
