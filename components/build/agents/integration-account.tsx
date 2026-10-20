"use client"

import { useRef } from "react"
import { ExternalLink, MoreHorizontal, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IntegrationLogo } from "@/components/ui/integration-logo"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { BuildStatus } from "@/components/build/shared/build-layout"
import type { AppConnection } from "@/src/lib/build/integrations"

const statusLabels = {
  active: "Connected",
  pending: "Awaiting authorization",
  failed: "Connection failed",
  disconnected: "Disconnected",
}

export function IntegrationAccount({
  account,
  name,
  busy,
  checking,
  authorizationUrl,
  onCheck,
  onDisconnect,
}: {
  account: AppConnection
  name: string
  busy: boolean
  checking: boolean
  authorizationUrl?: string
  onCheck: () => void
  onDisconnect: (trigger: HTMLButtonElement | null) => void
}) {
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const disconnectOnClose = useRef(false)
  const needsAttention =
    account.status === "pending" || account.status === "failed"
  return (
    <Card role="group" aria-label={name} className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <IntegrationLogo slug={account.toolkit} size="sm" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium break-words">{name}</p>
          <BuildStatus
            state={account.status === "failed" ? "error" : account.status}
            label={
              checking ? "Checking connection…" : statusLabels[account.status]
            }
          />
        </div>
        {account.status !== "disconnected" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuTrigger}
                variant="ghost-muted"
                size="icon-sm"
                aria-label={`Options for ${name}`}
                disabled={busy}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (disconnectOnClose.current) {
                  event.preventDefault()
                  disconnectOnClose.current = false
                  onDisconnect(menuTrigger.current)
                }
              }}
            >
              <DropdownMenuItem onSelect={onCheck}>
                <RefreshCw aria-hidden /> Check connection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  disconnectOnClose.current = true
                }}
              >
                <Unplug aria-hidden /> Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {needsAttention && (
        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-sm leading-relaxed text-foreground-muted">
            {account.status === "failed"
              ? "This account couldn’t connect. Check its status or add the account again."
              : authorizationUrl
                ? "Authorize access in a new tab, then come back here to check the connection."
                : "Finish authorizing in the app’s tab, then check the connection. If the link expired, add the account again."}
          </p>
          <div className="flex flex-wrap gap-2">
            {account.status === "pending" && authorizationUrl && (
              <Button asChild size="sm">
                <a
                  href={authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Authorize account{" "}
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              loading={checking}
              onClick={onCheck}
            >
              Check connection
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
