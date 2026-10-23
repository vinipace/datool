"use client"

import * as React from "react"
import { ArrowRight, Plus, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card"
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
  onOpenActions,
}: {
  active?: boolean
  onOpenActions?: () => void
}) {
  const trigger = React.useRef<HTMLButtonElement | null>(null)
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
      <IntegrationAccount
        key={account.id}
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
    )
  }

  return (
    <section
      aria-label="App integrations"
      className="@container w-full min-w-0 space-y-6 px-4 py-6 sm:px-6"
    >
      <div className="max-w-2xl space-y-2">
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm leading-relaxed text-foreground-muted">
          Connect the apps your agent can use. Manage accounts here, then choose
          the tools available to this agent in Actions.
        </p>
      </div>
      {connections.isLoading ? (
        <div
          role="status"
          aria-label="Loading app connections"
          className="grid gap-4 @min-[40rem]:grid-cols-2 @min-[64rem]:grid-cols-3"
        >
          {[0, 1, 2].map((item) => (
            <Card key={item} className="space-y-5 p-6">
              <Skeleton className="size-14 rounded-xl bg-border" />
              <Skeleton className="h-5 w-32 bg-border" />
              <Skeleton className="h-10 w-full bg-border" />
              <Skeleton className="h-9 w-full bg-border" />
            </Card>
          ))}
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
      ) : connections.data.apps.length === 0 ? (
        <Notice>No apps are available to connect yet.</Notice>
      ) : (
        <div className="grid gap-4 @min-[40rem]:grid-cols-2 @min-[64rem]:grid-cols-3">
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
            const manage = connected.length > 0 || waiting || failed
            return (
              <Card
                key={item.slug}
                role="group"
                aria-label={item.name}
                className="flex min-w-0 flex-col"
              >
                <CardHeader className="gap-5 px-6 pt-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <IntegrationLogo slug={item.slug} />
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
                  </div>
                  <div className="space-y-2">
                    <CardTitle>{item.name}</CardTitle>
                    <CardDescription className="leading-relaxed">
                      {appDescription(item)}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardFooter className="mt-auto px-6 pt-6 pb-6">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={busy}
                    onClick={(event) => {
                      trigger.current = event.currentTarget
                      setAppSlug(item.slug)
                      setError(null)
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
                </CardFooter>
              </Card>
            )
          })}
        </div>
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
                        Choose your store and authorize product and policy
                        access in Shopify. Your existing Datool billing stays in
                        place.
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
                {connected.length > 0 && onOpenActions && (
                  <div className="space-y-4 border-t border-border bg-muted p-6">
                    <div className="flex gap-3">
                      <Zap
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0 text-foreground-muted"
                      />
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">
                          Choose what your agent can do
                        </h3>
                        <p className="text-sm leading-relaxed text-foreground-muted">
                          Add tools from {app.name} in Actions. You control
                          which tools this agent can use.
                        </p>
                      </div>
                    </div>
                    <Button
                      className="w-full"
                      disabled={busy}
                      onClick={() => {
                        setAppSlug(null)
                        onOpenActions()
                      }}
                    >
                      Open Actions <ArrowRight aria-hidden />
                    </Button>
                  </div>
                )}
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
