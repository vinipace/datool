"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IntegrationLogo } from "@/components/ui/integration-logo"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { InspectorSection } from "@/components/ui/inspector-section"
import { IntegrationTools } from "./integration-tools"
import type { ActionRecord } from "@/src/lib/build/contracts"
import { CustomMcpDialog } from "./custom-mcp-dialog"
import { ShopifyChatSetup } from "./shopify-chat-setup"
import { IntegrationAccount } from "./integration-account"
import { BuildStatus } from "@/components/build/shared/build-layout"
import { useRemote } from "@/components/tracer/hooks"
import { buildApi } from "@/components/build/operations/build-api"
import type { IntegrationCatalog } from "@/src/lib/build/integrations"

const descriptions: Record<string, string> = {
  googlecalendar:
    "Bring calendar events and scheduling context into your agent’s conversations.",
  slack: "Bring messages and team conversations into your agent’s workflow.",
  shopify: "Help customers with store, product, and order information.",
  shopify_native:
    "Show live products, prices and availability, and answer questions using your store’s policies.",
  zendesk: "Bring support tickets and help center context into conversations.",
  github:
    "Give your agent context from repositories, issues, and pull requests.",
  notion: "Bring your team’s pages and knowledge into conversations.",
}

function appDescription(app: { slug: string; name: string }) {
  return (
    descriptions[app.slug] ??
    `Connect ${app.name} to let your agent use its available tools in conversations.`
  )
}

export function IntegrationsTab({
  active = true,
  onEditAction,
  onDefinitionDirty,
  agentId,
  beforeToolChange,
  onCatalogChanged,
}: {
  active?: boolean
  onEditAction?: (action: ActionRecord) => void
  onDefinitionDirty?: () => void
  agentId?: string
  beforeToolChange?: () => Promise<void>
  onCatalogChanged?: () => void
}) {
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const connections = useRemote(
    (signal) =>
      buildApi.call<IntegrationCatalog>(
        "build_list_app_connections",
        agentId ? { agentId } : {},
        signal
      ),
    [agentId],
    { enabled: active }
  )
  const [mcpDialog, setMcpDialog] = React.useState<string | null>(null)
  const oauthResult = useSearchParams().get("mcpOAuth")
  const customConnections =
    connections.data?.connections.filter(
      (item) => item.toolkit === "custom_mcp"
    ) ?? []
  const [appSlug, setAppSlug] = React.useState<string | null>(null)
  const [disconnectId, setDisconnectId] = React.useState<string | null>(null)
  const disconnectTrigger = React.useRef<HTMLButtonElement | null>(null)
  const cancelDisconnectButton = React.useRef<HTMLButtonElement | null>(null)
  const accountSection = React.useRef<HTMLHeadingElement | null>(null)
  const [checkingId, setCheckingId] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [authorization, setAuthorization] = React.useState<{
    id: string
    url: string
  } | null>(null)
  const app = connections.data?.apps.find((item) => item.slug === appSlug)
  const accounts =
    connections.data?.connections.filter((item) => item.toolkit === appSlug) ??
    []
  const connected = accounts.filter((item) => item.status === "active")
  const currentAttempt =
    accounts.find(
      (item) => item.id === authorization?.id && item.status === "pending"
    ) ??
    (connected.length === 0
      ? accounts.find(
          (item) => item.status === "pending" || item.status === "failed"
        )
      : undefined)
  const visibleAccounts = currentAttempt
    ? [...connected, currentAttempt]
    : connected
  const otherAccounts = accounts.filter(
    (item) => !visibleAccounts.includes(item)
  )
  const disconnectAccount = accounts.find((item) => item.id === disconnectId)
  const busy = pending || connections.isRefreshing

  React.useEffect(() => {
    if (disconnectId) cancelDisconnectButton.current?.focus()
  }, [disconnectId])

  function cancelDisconnect() {
    setDisconnectId(null)
    setError(null)
    requestAnimationFrame(() => disconnectTrigger.current?.focus())
  }

  async function run(action: () => Promise<void>) {
    if (pending) return
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

  function connect(slug: string) {
    return run(async () => {
      const result = await buildApi.call<{ id: string; redirectUrl: string }>(
        "build_connect_app",
        {
          toolkit: slug,
        }
      )
      setAuthorization({ id: result.id, url: result.redirectUrl })
      connections.refresh()
    })
  }

  function checkConnection(id: string) {
    return run(async () => {
      setCheckingId(id)
      try {
        await buildApi.call("build_refresh_app_connection", {
          connectionId: id,
        })
        connections.refresh()
      } finally {
        setCheckingId(null)
      }
    })
  }

  function renderAccount(account: IntegrationCatalog["connections"][number]) {
    return (
      <div key={account.id} className="space-y-3">
        <IntegrationAccount
          account={account}
          name={
            accounts.filter(
              (item) =>
                item.label === account.label && item.status === account.status
            ).length > 1
              ? `${account.label} · Account ${accounts.filter((item) => item.status === account.status).indexOf(account) + 1}`
              : `${account.label} account`
          }
          busy={busy}
          checking={checkingId === account.id}
          authorizationUrl={
            authorization?.id === account.id ? authorization.url : undefined
          }
          onCheck={() => checkConnection(account.id)}
          onDisconnect={(element) => {
            disconnectTrigger.current = element
            setError(null)
            setDisconnectId(account.id)
          }}
        />
        {agentId && account.status === "active" && (
          <IntegrationTools
            agentId={agentId}
            connectionId={account.id}
            connectionLabel={account.label}
            onChanged={onDefinitionDirty}
            onEdit={(action) => {
              setAppSlug(null)
              onEditAction?.(action)
            }}
          />
        )}
        {account.toolkit === "shopify_native" &&
          account.status === "active" && (
            <ShopifyChatSetup connectionId={account.id} />
          )}
      </div>
    )
  }

  return (
    <section
      aria-label="App integrations"
      className="@container w-full min-w-0 space-y-6 px-4 py-6 sm:px-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-lg font-semibold">Integrations</h2>
          <p className="text-sm leading-relaxed text-foreground-muted">
            Connect apps and custom MCP servers. Custom MCP tools are added to
            this agent automatically. Choose tools in each integration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Refresh integrations"
            loading={connections.isRefreshing}
            disabled={connections.isLoading || pending}
            onClick={connections.refresh}
          >
            <RefreshCw aria-hidden />
          </Button>
          <Button
            size="sm"
            disabled={connections.isLoading || Boolean(connections.error)}
            onClick={() => setMcpDialog("new")}
          >
            <Plus aria-hidden /> Add custom MCP
          </Button>
        </div>
      </div>
      {(oauthResult === "success" ||
        oauthResult === "error" ||
        oauthResult === "tools_error") && (
        <Notice
          variant={oauthResult === "success" ? "success" : "error"}
          role={oauthResult === "success" ? "status" : "alert"}
        >
          {oauthResult === "success"
            ? "MCP account connected. Its tools are available to this agent."
            : oauthResult === "tools_error"
              ? "MCP account connected, but its tools could not be enabled. Open the connection to choose tools."
              : "MCP sign-in was not completed. Open the connection and try again."}
        </Notice>
      )}
      {error && !appSlug && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      {connections.isLoading ? (
        <div
          role="status"
          aria-label="Loading app connections"
          className="space-y-2"
        >
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="flex items-center gap-3 rounded-md bg-surface-row p-4"
            >
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
      ) : connections.error ? (
        <Notice variant="error" role="alert">
          {connections.error.message}{" "}
          <Button size="sm" variant="outline" onClick={connections.refresh}>
            Retry connections
          </Button>
        </Notice>
      ) : (
        <>
          {customConnections.length > 0 && (
            <section aria-label="Custom MCP servers" className="space-y-3">
              <h3 className="text-sm font-medium">Custom MCP servers</h3>
              <div role="list" className="space-y-0.5">
                {customConnections.map((item) => (
                  <div role="listitem" key={item.id}>
                    <div
                      role="group"
                      aria-label={item.label}
                      className="flex min-w-0 flex-wrap items-center gap-3 rounded-md bg-surface-row px-4 py-3"
                    >
                      <IntegrationLogo slug="custom-mcp" size="sm" />
                      <div className="min-w-0 flex-1 basis-32 space-y-1">
                        <p className="text-sm font-medium break-words">
                          {item.label}
                        </p>
                        <p
                          className="truncate text-xs text-foreground-muted"
                          title={item.mcpUrl}
                        >
                          {item.mcpUrl}
                        </p>

                      </div>
                      <BuildStatus
                        state={item.status === "failed" ? "error" : item.status}
                        label={
                          item.status === "active"
                            ? "Connected"
                            : item.status === "disconnected"
                              ? "Disconnected"
                              : "Needs attention"
                        }
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setMcpDialog(item.id)}
                      >
                        Manage
                      </Button>

                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section aria-label="Available apps" className="space-y-3">
            {customConnections.length > 0 && (
              <h3 className="text-sm font-medium">Apps</h3>
            )}
            {!connections.data?.configured ? (
              <Notice>
                App integrations need administrator setup before you can connect
                an account. You can still add a custom MCP server.
              </Notice>
            ) : connections.data.apps.length === 0 ? (
              <Notice>
                No apps are available yet. Add a custom MCP server by URL to
                connect your own tools.
              </Notice>
            ) : (
              <div role="list" className="space-y-0.5">
                {connections.data.apps.map((item) => {
                  const appAccounts = connections.data!.connections.filter(
                    (account) => account.toolkit === item.slug
                  )
                  const connected = appAccounts.filter(
                    (account) => account.status === "active"
                  )
                  const waiting = appAccounts.some(
                    (account) => account.status === "pending"
                  )
                  const failed = appAccounts.some(
                    (account) => account.status === "failed"
                  )
                  const manage = appAccounts.length > 0
                  return (
                    <div role="listitem" key={item.slug}>
                      <div
                        role="group"
                        aria-label={item.name}
                        className="flex min-w-0 flex-wrap items-center gap-3 rounded-md bg-surface-row px-4 py-3"
                      >
                        <IntegrationLogo slug={item.slug} size="sm" />
                        <div className="min-w-0 flex-1 basis-48 space-y-1">
                          <p className="text-sm font-medium">{item.name}</p>
                          <p className="text-xs leading-relaxed text-foreground-muted">
                            {appDescription(item)}
                          </p>
                        </div>
                        {connected.length > 0 ? (
                          <BuildStatus
                            state="connected"
                            label={
                              connected.length === 1
                                ? "Connected"
                                : `${connected.length} connected`
                            }
                          />
                        ) : waiting ? (
                          <BuildStatus state="pending" label="Pending" />
                        ) : failed ? (
                          <BuildStatus state="error" label="Needs attention" />
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={(event) => {
                            trigger.current = event.currentTarget
                            setAppSlug(item.slug)
                            setError(null)
                            if (
                              !appAccounts.some(
                                (account) => account.id === authorization?.id
                              )
                            )
                              setAuthorization(null)
                            if (
                              !manage &&
                              !item.connectionMethod &&
                              item.available !== false
                            )
                              void connect(item.slug)
                          }}
                        >
                          {manage ? "Manage" : "Connect"}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
      {mcpDialog && (
        <CustomMcpDialog
          key={mcpDialog}
          open={active}
          connection={customConnections.find((item) => item.id === mcpDialog)}
          agentId={agentId}
          beforeSave={beforeToolChange}
          onOpenChange={(open) => {
            if (!open) setMcpDialog(null)
          }}
          onSaved={(result) => {
            connections.refresh()
            if (result?.toolsReady === false)
              setError(
                "MCP connected, but its tools could not be enabled. Open the connection to choose tools."
              )
            if (result?.agentRevision) onCatalogChanged?.()
          }}
          onDefinitionDirty={onDefinitionDirty}
          onEditAction={(action) => {
            setMcpDialog(null)
            onEditAction?.(action)
          }}
        />
      )}
      <Dialog
        open={active && Boolean(app)}
        onOpenChange={(open) => {
          if (!open && !pending && !disconnectId) setAppSlug(null)
        }}
      >
        <DialogContent
          className="gap-0 bg-background p-0"
          role={disconnectAccount ? "alertdialog" : "dialog"}
          showCloseButton={!pending && !disconnectAccount}
          onCloseAutoFocus={(event) => {
            if (active && trigger.current?.isConnected) {
              event.preventDefault()
              trigger.current.focus()
            }
          }}
          onEscapeKeyDown={(event) => {
            if (pending || disconnectId) event.preventDefault()
            if (disconnectId && !pending) cancelDisconnect()
          }}
          onInteractOutside={(event) => {
            if (pending || disconnectId) event.preventDefault()
          }}
        >
          {app && (
            <>
              <DialogHeader className="gap-4 border-b border-border p-6">
                <div className="flex items-center gap-4 pr-6">
                  <IntegrationLogo slug={app.slug} />
                  <div className="min-w-0 space-y-1">
                    <DialogTitle className="pr-0 text-lg">
                      {disconnectAccount ? `Disconnect ${app.name}?` : app.name}
                    </DialogTitle>
                    <p className="text-xs text-foreground-muted">
                      App integration
                    </p>
                  </div>
                </div>
                <DialogDescription className="leading-relaxed">
                  {disconnectAccount
                    ? "Every agent in this project will lose access to this account. Actions using it will stop working until you connect an account again."
                    : appDescription(app)}
                </DialogDescription>
              </DialogHeader>
              <div hidden={Boolean(disconnectAccount)}>
                <div className="space-y-4 p-6">
                  {error && !disconnectId && (
                    <Notice variant="error" role="alert">
                      {error}
                    </Notice>
                  )}
                  {connections.error && (
                    <Notice variant="error" role="alert">
                      {connections.error.message}{" "}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={connections.refresh}
                      >
                        Retry connections
                      </Button>
                    </Notice>
                  )}
                  {app.available === false ? (
                    <Notice>
                      This integration needs administrator setup before you can
                      connect an account.
                    </Notice>
                  ) : app.connectionMethod === "shopify" ? (
                    <div className="space-y-3">
                      <p className="text-sm text-foreground-muted">
                        Choose your store and review Datool’s requested access
                        in Shopify. Your existing Datool billing stays in place.
                      </p>
                      {authorization ? (
                        <Button asChild>
                          <a href={authorization.url}>Continue to Shopify</a>
                        </Button>
                      ) : (
                        <Button
                          loading={busy}
                          disabled={busy}
                          onClick={() => void connect(app.slug)}
                        >
                          Connect store
                        </Button>
                      )}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <h3
                      ref={accountSection}
                      tabIndex={-1}
                      className="text-sm font-medium"
                    >
                      Accounts
                    </h3>
                    {visibleAccounts.length > 0 &&
                      !app.connectionMethod &&
                      app.available !== false && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => connect(app.slug)}
                        >
                          <Plus aria-hidden /> Add account
                        </Button>
                      )}
                  </div>
                  {visibleAccounts.length > 0 ? (
                    <div className="space-y-3">
                      {visibleAccounts.map(renderAccount)}
                    </div>
                  ) : !app.connectionMethod && app.available !== false ? (
                    <Card className="space-y-4 p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          Connect your first account
                        </p>
                        <p className="text-sm leading-relaxed text-foreground-muted">
                          Securely authorize {app.name} to make its tools
                          available to your agents.
                        </p>
                      </div>
                      <Button loading={busy} onClick={() => connect(app.slug)}>
                        <Plus aria-hidden /> Connect account
                      </Button>
                    </Card>
                  ) : null}
                  <p className="text-xs leading-relaxed text-foreground-muted">
                    Accounts are shared across agents in this project.
                  </p>
                  {otherAccounts.length > 0 && (
                    <InspectorSection
                      label={`Other connections (${otherAccounts.length})`}
                      defaultOpen={false}
                    >
                      <div className="space-y-3">
                        {otherAccounts.map(renderAccount)}
                      </div>
                    </InspectorSection>
                  )}
                </div>
              </div>
              {disconnectAccount && (
                <div className="space-y-4 p-6">
                  {error && (
                    <Notice variant="error" role="alert">
                      {error}
                    </Notice>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      ref={cancelDisconnectButton}
                      variant="outline"
                      disabled={pending}
                      onClick={cancelDisconnect}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      loading={pending}
                      onClick={() => {
                        void run(async () => {
                          try {
                            await buildApi.call("build_disconnect_app", {
                              connectionId: disconnectAccount.id,
                            })
                            if (authorization?.id === disconnectAccount.id)
                              setAuthorization(null)
                            setDisconnectId(null)
                            requestAnimationFrame(() =>
                              accountSection.current?.focus()
                            )
                          } finally {
                            connections.refresh()
                          }
                        })
                      }}
                    >
                      Disconnect account
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
