"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Smartphone,
  Unplug,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { StatusPill } from "@/components/tracer/primitives"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { buildApi } from "@/components/build/operations/build-api"
import { useRemote } from "@/components/tracer/hooks"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import {
  EVOLUTION_ACCEPTANCE_VERSION,
  type EvolutionConnection,
  type EvolutionPairing,
} from "@/src/lib/build/evolution"

type Action = "pair" | "refresh" | "pause" | "disconnect"

export function EvolutionEditor({
  connection,
  agent,
  fromAgent,
}: {
  connection: ChannelConnection | null
  agent: ManagedAgent
  fromAgent: boolean
}) {
  const href = useWorkspaceHref()
  const [saved, setSaved] = React.useState(connection)
  const [accepted, setAccepted] = React.useState(false)
  const [action, setAction] = React.useState<Action | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pairing, setPairing] = React.useState<EvolutionPairing | null>(null)
  const [secondsLeft, setSecondsLeft] = React.useState(0)
  const [qrExpired, setQrExpired] = React.useState(false)
  const [disconnect, setDisconnect] = React.useState<
    "disconnect" | "change" | null
  >(null)
  const disconnectTrigger = React.useRef<HTMLButtonElement | null>(null)
  const busy = React.useRef(false)
  const createKey = React.useRef(crypto.randomUUID())
  const info = useRemote(
    (signal) =>
      buildApi.call<EvolutionConnection>(
        "build_get_evolution_connection",
        { connectionId: saved?.id },
        signal
      ),
    [saved?.id],
    { enabled: !!saved }
  )
  const refreshInfo = React.useEffectEvent(() => info.refresh())
  const state = info.data ?? pairing
  const pending = action !== null
  const connected = state?.state === "open"
  const paused = state?.status === "paused"
  const cleaning = !!state?.cleanupPending
  const unavailable = state?.enabled === false
  const loading = !!saved && !state && info.isLoading
  const canPair = !connected && !cleaning && !loading && (!saved || !!state)
  const hasSession =
    connected ||
    cleaning ||
    state?.state === "connecting" ||
    !!state?.phone ||
    !!pairing
  const statusLabel = cleaning
    ? "Disconnecting"
    : connected
      ? "Connected"
      : state?.phone
        ? "Connection lost"
        : pairing?.qr
          ? "Ready to scan"
          : qrExpired
            ? "QR expired"
            : state?.state === "connecting"
              ? "Waiting for WhatsApp"
              : "Not connected"
  const back = fromAgent
    ? href(`/build/agents/${agent.id}?section=channels`)
    : href(`/build/integrations?agentId=${agent.id}`)

  async function run(kind: Action, task: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setAction(kind)
    setError(null)
    try {
      await task()
      info.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the connection."
      )
    } finally {
      busy.current = false
      setAction(null)
    }
  }
  React.useEffect(() => {
    if (!pairing?.expiresAt) return
    const expiresAt = new Date(pairing.expiresAt).getTime()
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (!remaining) {
        setPairing(null)
        setQrExpired(true)
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [pairing])
  React.useEffect(() => {
    if (!saved || !pairing || connected) return
    const timer = setInterval(() => refreshInfo(), 3000)
    return () => clearInterval(timer)
  }, [saved, pairing, connected])

  async function pair() {
    await run("pair", async () => {
      const target =
        saved ??
        (await buildApi.call<ChannelConnection>(
          "build_create_channel",
          {
            agentId: agent.id,
            channel: "whatsapp",
            label: "WhatsApp · Evolution",
            config: { provider: "evolution" },
          },
          { idempotencyKey: createKey.current }
        ))
      setSaved(target)
      if (!saved) {
        // Preserve the query so creating the channel does not remount its QR.
        const url = new URL(window.location.href)
        url.pathname = href(`/build/integrations/${target.id}`)
        window.history.replaceState(null, "", url)
      }
      const result = await buildApi.call<EvolutionPairing>(
        "build_begin_evolution_connection",
        {
          connectionId: target.id,
          acceptanceVersion: EVOLUTION_ACCEPTANCE_VERSION,
        }
      )
      setQrExpired(false)
      setSecondsLeft(
        result.expiresAt
          ? Math.max(
              0,
              Math.ceil(
                (new Date(result.expiresAt).getTime() - Date.now()) / 1000
              )
            )
          : 0
      )
      setPairing(result)
    })
  }

  return (
    <div className="@container/evolution mx-auto w-full max-w-4xl space-y-6 px-3 py-4 sm:px-6 sm:py-6">
      <Button variant="ghost-muted" size="sm" asChild>
        <Link href={back}>
          <ArrowLeft aria-hidden="true" />
          Back to channels
        </Link>
      </Button>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelIcon channel="whatsapp" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">WhatsApp</h2>
            <p className="text-sm text-foreground-muted">
              Via Evolution · Unofficial connection
            </p>
          </div>
        </div>
        <div role="status">
          <StatusPill
            status={
              loading
                ? "Checking connection"
                : info.error && !state
                  ? "Status unavailable"
                  : statusLabel
            }
          />
        </div>
      </header>

      {error && !disconnect && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
      {info.error && (
        <Notice variant="error" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Could not load the latest connection status.</span>
            <Button variant="outline" size="sm" onClick={info.refresh}>
              Retry
            </Button>
          </div>
        </Notice>
      )}
      {unavailable && (
        <Notice variant="info">
          This project is not enabled for the Evolution pilot. New automated
          replies are disabled.
        </Notice>
      )}

      {loading ? (
        <Card
          className="space-y-5 p-5 sm:p-6"
          role="status"
          aria-label="Loading connection"
        >
          <Skeleton className="h-5 w-40 bg-border" />
          <Skeleton className="h-4 w-64 max-w-full bg-border" />
          <Skeleton className="h-64 w-64 max-w-full bg-border" />
          <span className="sr-only">Loading connection</span>
        </Card>
      ) : cleaning ? (
        <Notice variant="warning" title="Finishing disconnection">
          <p>
            Replies are stopped. Remove the remaining session before connecting
            another number.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              disconnectTrigger.current = event.currentTarget
              setError(null)
              setDisconnect("disconnect")
            }}
          >
            Retry disconnect
          </Button>
        </Notice>
      ) : connected ? (
        <Card className="divide-y divide-border">
          <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground-muted">
                CONNECTED NUMBER
              </p>
              <h3 className="text-xl font-semibold tabular-nums">
                {state?.phone ? `+${state.phone}` : "WhatsApp connected"}
              </h3>
              <p className="text-sm text-foreground-muted">
                Managed by {agent.name}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={(event) => {
                disconnectTrigger.current = event.currentTarget
                setError(null)
                setDisconnect("change")
              }}
            >
              <Smartphone aria-hidden="true" />
              Change number
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">
                {paused ? "Agent paused" : "Automatic replies"}
              </h3>
              <p className="max-w-md text-sm text-foreground-muted">
                {unavailable
                  ? "Replies are disabled while this project is outside the pilot."
                  : paused
                    ? "The number stays connected. Resume when you are ready to reply."
                    : "Your agent replies to individual text conversations started by customers."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || (paused && unavailable)}
              loading={action === "pause"}
              onClick={() =>
                run("pause", async () => {
                  await buildApi.call("build_update_channel_status", {
                    connectionId: saved?.id,
                    status: paused ? "connected" : "paused",
                  })
                })
              }
            >
              {paused ? (
                <Play aria-hidden="true" />
              ) : (
                <Pause aria-hidden="true" />
              )}
              {paused ? "Resume agent" : "Pause agent"}
            </Button>
          </div>
          <div className="space-y-2 p-5 sm:p-6">
            <h3 className="text-sm font-medium">Test your connection</h3>
            <p className="text-sm text-foreground-muted">
              Send a message to this number from another WhatsApp account, then
              check the conversation and reply.
            </p>
            <Button variant="link" size="sm" className="px-0" asChild>
              <Link
                href={href(`/build/agents/${agent.id}?section=conversations`)}
              >
                Open conversations
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </Card>
      ) : canPair ? (
        <Card className="overflow-hidden">
          <div className="border-b border-border p-5 sm:p-6">
            <h3 className="text-base font-semibold">Connect your number</h3>
            <p className="mt-1 text-sm text-foreground-muted">
              Link WhatsApp to {agent.name} using your phone.
            </p>
          </div>
          <div className="grid gap-8 p-5 sm:p-6 @min-[640px]/evolution:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-6">
              <ol className="space-y-5" aria-label="Connection steps">
                {[
                  [
                    "Open WhatsApp on your phone",
                    "Use the account you want customers to contact.",
                  ],
                  [
                    "Go to Linked devices",
                    "Open Settings on iPhone, or the ⋮ menu on Android, then choose Link a device.",
                  ],
                  [
                    "Scan the QR code",
                    "Keep this page open until your number appears as connected.",
                  ],
                ].map(([title, description], index) => (
                  <li key={title} className="flex gap-3">
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-foreground-muted"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{title}</p>
                      <p className="text-sm leading-5 text-foreground-muted">
                        {description}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <Notice variant="warning" title="Before you connect">
                WhatsApp may restrict or ban this number, even if you only reply
                to customers. This is not an official Meta connection.
              </Notice>
              {!pairing?.qr && (
                <label className="flex items-start gap-3 text-sm leading-5">
                  <Checkbox
                    className="mt-0.5"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                    disabled={pending || unavailable}
                  />
                  <span>
                    I understand this risk and authorize connecting my number.
                  </span>
                </label>
              )}
              {pairing?.qr && (
                <p className="flex items-center gap-2 text-xs text-foreground-muted">
                  <Check className="size-4" aria-hidden="true" />
                  Connection risk acknowledged
                </p>
              )}
            </div>
            <div
              className={
                pairing?.qr
                  ? "order-first flex flex-col items-center gap-4 @min-[640px]/evolution:order-last"
                  : "flex flex-col items-center gap-4"
              }
            >
              <div className="flex aspect-square w-full max-w-[280px] items-center justify-center rounded-xl border border-border bg-background p-3">
                {pairing?.qr && action !== "pair" ? (
                  <Image
                    src={pairing.qr}
                    alt="Scan this QR code with WhatsApp to connect your number"
                    width={256}
                    height={256}
                    className="h-auto w-full"
                    unoptimized
                  />
                ) : (
                  <div className="space-y-3 px-3 text-center" role="status">
                    <QrCode
                      className="mx-auto size-10 text-foreground-muted"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium">
                      {action === "pair"
                        ? "Preparing your QR code…"
                        : qrExpired
                          ? "Your QR code expired"
                          : pairing
                            ? "Preparing your connection"
                            : "Ready when you are"}
                    </p>
                    <p className="text-xs leading-5 text-foreground-muted">
                      {action === "pair"
                        ? "This can take a few seconds."
                        : qrExpired
                          ? "Generate a fresh code to continue."
                          : pairing
                            ? "Generate a new code in a few seconds."
                            : "A QR code will appear here after you accept the notice."}
                    </p>
                  </div>
                )}
              </div>
              {pairing?.qr && (
                <p className="flex items-center gap-1.5 text-xs text-foreground-muted tabular-nums">
                  <Clock3 className="size-3.5" aria-hidden="true" />
                  Code expires in {secondsLeft}s
                </p>
              )}
              <Button
                className="w-full max-w-[280px]"
                variant={pairing?.qr ? "outline" : "default"}
                disabled={!accepted || pending || unavailable}
                loading={action === "pair"}
                onClick={pair}
              >
                {action !== "pair" &&
                  (pairing?.qr || qrExpired ? (
                    <RefreshCw aria-hidden="true" />
                  ) : (
                    <QrCode aria-hidden="true" />
                  ))}
                {action === "pair"
                  ? "Generating QR code…"
                  : pairing?.qr || qrExpired || state?.state === "connecting"
                    ? "Get a new QR code"
                    : "Generate QR code"}
              </Button>
              <p className="max-w-[280px] text-center text-xs leading-5 text-foreground-muted">
                {pairing?.qr
                  ? "Waiting for you to scan. We’ll check the connection automatically."
                  : "Already scanned? Use Check connection below."}
              </p>
            </div>
          </div>
          <div className="border-t border-border px-5 py-3 text-xs leading-5 text-foreground-muted sm:px-6">
            Pilot: individual text conversations started by customers. No
            campaigns or group chats.
          </div>
        </Card>
      ) : null}

      {saved && !loading && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={pending || info.isRefreshing}
              loading={action === "refresh" || info.isRefreshing}
              onClick={() =>
                run("refresh", async () => {
                  await buildApi.call("build_refresh_evolution_connection", {
                    connectionId: saved.id,
                  })
                })
              }
            >
              <RefreshCw aria-hidden="true" />
              Check connection
            </Button>
            {state?.checkedAt && (
              <p className="px-2.5 text-xs text-foreground-muted">
                Last checked{" "}
                {new Date(state.checkedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
          </div>
          {hasSession && !cleaning && (
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={pending}
              onClick={(event) => {
                disconnectTrigger.current = event.currentTarget
                setError(null)
                setDisconnect("disconnect")
              }}
            >
              <Unplug aria-hidden="true" />
              {connected ? "Disconnect" : "Cancel connection"}
            </Button>
          )}
        </div>
      )}
      <footer className="border-t border-border pt-4 text-xs leading-5 text-foreground-muted">
        Powered by{" "}
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
          <a
            href="https://github.com/evolution-foundation/evolution-api"
            target="_blank"
            rel="noreferrer"
          >
            Evolution API
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        </Button>
        . Managed by Datool. Not endorsed by Evolution Foundation or Meta.
      </footer>
      <Dialog
        open={!!disconnect}
        onOpenChange={(open) => {
          if (!pending && !open) setDisconnect(null)
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            disconnectTrigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {disconnect === "change"
                ? "Connect a different number?"
                : "Disconnect this number?"}
            </DialogTitle>
            <DialogDescription>
              {disconnect === "change"
                ? "We’ll disconnect the current number first. Then you can generate a QR code and scan it with the other WhatsApp account."
                : "This stops new replies, cancels queued sends and removes the WhatsApp session."}{" "}
              Your Datool conversation history stays available.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDisconnect(null)}
            >
              Keep current connection
            </Button>
            <Button
              variant={disconnect === "change" ? "default" : "destructive"}
              loading={action === "disconnect"}
              disabled={pending}
              onClick={() =>
                run("disconnect", async () => {
                  await buildApi.call("build_disconnect_evolution", {
                    connectionId: saved?.id,
                  })
                  setPairing(null)
                  setQrExpired(false)
                  setAccepted(false)
                  setDisconnect(null)
                })
              }
            >
              {disconnect === "change"
                ? "Disconnect and change number"
                : "Disconnect number"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
