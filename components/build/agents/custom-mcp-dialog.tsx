"use client"

import * as React from "react"
import { ArrowLeft, ChevronDown, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { BuildStatus } from "@/components/build/shared/build-layout"
import { buildApi } from "@/components/build/operations/build-api"
import { IntegrationTools } from "./integration-tools"
import type { ActionRecord } from "@/src/lib/build/contracts"
import type { AppConnection } from "@/src/lib/build/integrations"

export function CustomMcpDialog({
  connection,
  onBack,
  onSaved,
  onEditAction,
  onDefinitionDirty,
  agentId,
  beforeSave,
}: {
  connection?: AppConnection
  onBack: () => void
  onSaved: (result?: { toolsReady?: boolean; agentRevision?: number }) => void
  onEditAction?: (action: ActionRecord) => void
  onDefinitionDirty?: () => void
  agentId?: string
  beforeSave?: () => Promise<void>
}) {
  const [name, setName] = React.useState(connection?.label ?? "")
  const [url, setUrl] = React.useState("")
  const [auth, setAuth] = React.useState(
    connection?.authType ??
      (connection ? (connection.hasToken ? "token" : "none") : "oauth")
  )
  const [token, setToken] = React.useState("")
  const [oauthSettings, setOauthSettings] = React.useState(false)
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")
  const [pending, setPending] = React.useState<
    "save" | "check" | "disconnect" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)
  const [checked, setChecked] = React.useState<AppConnection["status"] | null>(
    null
  )
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)
  const cancelButton = React.useRef<HTMLButtonElement>(null)
  const disconnectButton = React.useRef<HTMLButtonElement>(null)
  const disconnected = connection?.status === "disconnected"
  const status = checked ?? connection?.status
  const needsOAuth =
    auth === "oauth" &&
    (!connection ||
      connection.authType !== "oauth" ||
      status !== "active" ||
      Boolean(url.trim() || clientId.trim() || clientSecret.trim()))

  React.useEffect(() => {
    if (confirmDisconnect) cancelButton.current?.focus()
  }, [confirmDisconnect])

  function cancelDisconnect() {
    setConfirmDisconnect(false)
    setError(null)
    requestAnimationFrame(() => disconnectButton.current?.focus())
  }

  async function run(
    kind: NonNullable<typeof pending>,
    action: () => Promise<void>
  ) {
    if (pending) return
    setPending(kind)
    setError(null)
    setChecked(null)
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to update the MCP connection."
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <section
      aria-label={connection?.label ?? "Add custom MCP"}
      className="mx-auto w-full max-w-4xl space-y-5"
    >
      <Button
        type="button"
        variant="ghost-muted"
        size="sm"
        disabled={Boolean(pending)}
        onClick={onBack}
      >
        <ArrowLeft aria-hidden /> Integrations
      </Button>
      <header className="space-y-2 border-b border-border pb-5">
        <h2 className="text-lg font-semibold">
          {connection?.label ?? "Add custom MCP"}
        </h2>
        <p className="text-sm text-foreground-muted">
          {agentId
            ? "Connect an MCP server to add its tools to this agent. Manage individual tools here."
            : "Connect an MCP server by URL. Connections are shared across agents in this project."}
        </p>
      </header>
      <Dialog
        open={confirmDisconnect}
        onOpenChange={(open) => {
          if (!open && !pending) cancelDisconnect()
        }}
      >
        <DialogContent role="alertdialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Disconnect {connection?.label}?</DialogTitle>
            <DialogDescription>
              Every agent in this project will lose access to this account.
              Actions using it will stop working until you reconnect it.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              ref={cancelButton}
              variant="outline"
              disabled={Boolean(pending)}
              onClick={cancelDisconnect}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending === "disconnect"}
              disabled={Boolean(pending)}
              onClick={() =>
                void run("disconnect", async () => {
                  if (!connection) return
                  await buildApi.call("build_disconnect_app", {
                    connectionId: connection.id,
                  })
                  onSaved()
                  onBack()
                })
              }
            >
              Disconnect account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {error && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      <>
        {connection && status && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-4">
            <BuildStatus
              state={status === "failed" ? "error" : status}
              label={
                status === "active"
                  ? "Connected"
                  : status === "disconnected"
                    ? "Disconnected"
                    : "Needs attention"
              }
            />
            {!disconnected && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost-muted"
                  loading={pending === "check"}
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void run("check", async () => {
                      const result = await buildApi.call<AppConnection>(
                        "build_refresh_app_connection",
                        { connectionId: connection.id }
                      )
                      setChecked(result.status)
                      onSaved()
                    })
                  }
                >
                  <RefreshCw aria-hidden /> Check connection
                </Button>
                <Button
                  ref={disconnectButton}
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label="Disconnect MCP account"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setError(null)
                    setConfirmDisconnect(true)
                  }}
                >
                  <Unplug aria-hidden />
                </Button>
              </div>
            )}
          </div>
        )}
        {checked && (
          <Notice
            variant={checked === "active" ? "success" : "error"}
            role="status"
          >
            {checked === "active"
              ? "Connection checked. Your MCP server is available."
              : "Unable to reach this MCP server. Check the URL or sign in again to reconnect."}
          </Notice>
        )}
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            void run("save", async () => {
              await beforeSave?.()
              if (needsOAuth) {
                const result = await buildApi.call<{ redirectUrl: string }>(
                  "build_start_mcp_oauth",
                  {
                    ...(connection ? { connectionId: connection.id } : {}),
                    ...(agentId ? { agentId } : {}),
                    name: name.trim(),
                    ...(url.trim() ? { url: url.trim() } : {}),
                    ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
                    ...(clientSecret.trim()
                      ? { clientSecret: clientSecret.trim() }
                      : {}),
                    returnTo: (() => {
                      const target = new URL(window.location.href)
                      if (!connection) target.searchParams.delete("mcp")
                      return target.pathname + target.search
                    })(),
                  }
                )
                window.location.assign(result.redirectUrl)
                return
              }
              const result = await buildApi.call<{
                toolsReady?: boolean
                agentRevision?: number
              }>("build_save_mcp_connection", {
                ...(connection ? { connectionId: connection.id } : {}),
                ...(agentId ? { agentId } : {}),
                name: name.trim(),
                ...(url.trim() ? { url: url.trim() } : {}),
                authType: auth,
                ...(auth === "token"
                  ? { token: token.trim() || undefined }
                  : auth === "none"
                    ? { token: "" }
                    : {}),
              })
              setToken("")
              onSaved(result)
              onBack()
            })
          }}
        >
          <fieldset disabled={Boolean(pending)} className="min-w-0 space-y-5">
            <FormRow
              label="Name"
              htmlFor="mcp-name"
              layout="vertical"
              variant="plain"
            >
              <Input
                id="mcp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
                placeholder="My MCP server"
              />
            </FormRow>
            <FormRow
              label="Server URL"
              htmlFor="mcp-url"
              layout="vertical"
              variant="plain"
              descriptionId="mcp-url-help"
              description={
                connection && !disconnected
                  ? "Leave empty to keep the saved URL. Enter a new URL to replace it."
                  : "Use the public HTTPS endpoint for a Streamable HTTP MCP server."
              }
            >
              <Input
                id="mcp-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required={!connection || disconnected}
                maxLength={4096}
                placeholder={connection?.mcpUrl ?? "https://example.com/mcp"}
                aria-describedby="mcp-url-help"
                autoComplete="off"
              />
            </FormRow>
            <FormRow
              label="Authentication"
              htmlFor="mcp-auth"
              layout="vertical"
              variant="plain"
              descriptionId={auth === "oauth" ? "mcp-oauth-help" : undefined}
              description={
                auth === "oauth"
                  ? "Sign in securely with the MCP server. No access token to copy."
                  : undefined
              }
            >
              <Select
                id="mcp-auth"
                value={auth}
                onChange={(event) =>
                  setAuth(
                    event.target.value as NonNullable<AppConnection["authType"]>
                  )
                }
                aria-describedby={
                  auth === "oauth" ? "mcp-oauth-help" : undefined
                }
              >
                <option value="oauth">OAuth (recommended)</option>
                <option value="token">Access token</option>
                <option value="none">No authentication</option>
              </Select>
            </FormRow>
            {auth === "oauth" && (
              <div className="space-y-4">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  aria-expanded={oauthSettings}
                  aria-controls="mcp-oauth-settings"
                  onClick={() => setOauthSettings(!oauthSettings)}
                >
                  <ChevronDown
                    aria-hidden
                    className={oauthSettings ? "rotate-180" : undefined}
                  />{" "}
                  OAuth settings
                </Button>
                {oauthSettings && (
                  <div id="mcp-oauth-settings" className="space-y-4">
                    <FormRow
                      label="Client ID"
                      htmlFor="mcp-client-id"
                      layout="vertical"
                      variant="plain"
                      description="Optional. Only needed if this server requires a registered OAuth app."
                    >
                      <Input
                        id="mcp-client-id"
                        value={clientId}
                        onChange={(event) => setClientId(event.target.value)}
                        maxLength={2000}
                        autoComplete="off"
                      />
                    </FormRow>
                    <FormRow
                      label="Client secret"
                      htmlFor="mcp-client-secret"
                      layout="vertical"
                      variant="plain"
                      description="Optional. Stored securely when required by the server."
                    >
                      <Input
                        id="mcp-client-secret"
                        type="password"
                        value={clientSecret}
                        onChange={(event) =>
                          setClientSecret(event.target.value)
                        }
                        maxLength={4000}
                        autoComplete="new-password"
                      />
                    </FormRow>
                  </div>
                )}
              </div>
            )}
            {auth === "token" && (
              <FormRow
                label="Access token"
                htmlFor="mcp-token"
                layout="vertical"
                variant="plain"
                descriptionId="mcp-token-help"
                description={
                  connection?.hasToken
                    ? "A token is saved. Leave empty to keep it, or enter a replacement."
                    : "Sent as a bearer token and stored securely."
                }
              >
                <Input
                  id="mcp-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  maxLength={4000}
                  required={!connection?.hasToken}
                  autoComplete="new-password"
                  aria-describedby="mcp-token-help"
                  placeholder={
                    connection?.hasToken ? "Saved token" : "Enter access token"
                  }
                />
              </FormRow>
            )}
          </fieldset>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => onBack()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={pending === "save"}
              disabled={Boolean(pending) || !name.trim()}
            >
              {needsOAuth
                ? "Continue with OAuth"
                : connection
                  ? disconnected
                    ? "Reconnect MCP"
                    : "Save connection"
                  : "Connect MCP"}
            </Button>
          </div>
        </form>
        {status === "active" && connection && agentId && (
          <IntegrationTools
            agentId={agentId}
            connectionId={connection.id}
            connectionLabel={connection.label}
            onChanged={onDefinitionDirty}
            onEdit={onEditAction}
          />
        )}
      </>
    </section>
  )
}
