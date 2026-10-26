"use client"
import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Notice } from "@/components/ui/notice"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
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

export function EvolutionEditor({
  connection,
  agent,
  fromAgent,
}: {
  connection: ChannelConnection | null
  agent: ManagedAgent
  fromAgent: boolean
}) {
  const router = useRouter(),
    href = useWorkspaceHref()
  const [saved, setSaved] = React.useState(connection)
  const [accepted, setAccepted] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pairing, setPairing] = React.useState<EvolutionPairing | null>(null)
  const [disconnect, setDisconnect] = React.useState(false)
  const busy = React.useRef(false),
    createKey = React.useRef(crypto.randomUUID())
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
  const refreshInfo = info.refresh
  const state = info.data ?? pairing
  const back = fromAgent
    ? href(`/build/agents/${agent.id}?section=channels`)
    : href(`/build/integrations?agentId=${agent.id}`)
  async function run(action: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      await action()
      info.refresh()
      router.refresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the connection."
      )
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  React.useEffect(() => {
    if (!pairing?.expiresAt) return
    const timer = setTimeout(
      () => setPairing(null),
      Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now())
    )
    return () => clearTimeout(timer)
  }, [pairing])
  React.useEffect(() => {
    if (!saved || !pairing || state?.state === "open") return
    const timer = setInterval(refreshInfo, 3000)
    return () => clearInterval(timer)
  }, [saved, pairing, state?.state, refreshInfo])
  async function pair() {
    await run(async () => {
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
      window.history.replaceState(
        null,
        "",
        href(
          `/build/integrations/${target.id}?agentId=${agent.id}${fromAgent ? "&from=agent" : ""}`
        )
      )
      const result = await buildApi.call<EvolutionPairing>(
        "build_begin_evolution_connection",
        {
          connectionId: target.id,
          acceptanceVersion: EVOLUTION_ACCEPTANCE_VERSION,
        }
      )
      setPairing(result)
    })
  }
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild>
        <Link href={back}>Back to channels</Link>
      </Button>
      <Card>
        <CardHeader>
          <CardTitle>WhatsApp via Evolution</CardTitle>
          <CardDescription>
            Unofficial connection · Managed by Datool
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Notice variant="warning">
            This connection uses WhatsApp Web through Evolution API. WhatsApp
            may restrict or ban your number even when you only reply to
            customers. The pilot supports individual text conversations started
            by customers.
          </Notice>
          {error && <Notice variant="error">{error}</Notice>}
          {info.error && (
            <Notice variant="error">
              Could not load connection status.{" "}
              <Button variant="outline" size="sm" onClick={info.refresh}>
                Retry
              </Button>
            </Notice>
          )}
          {state && (
            <div className="space-y-1" role="status">
              <p className="text-sm">
                Status: {state.status} · Session:{" "}
                {state.state.replaceAll("_", " ")}
              </p>
              {state.phone && (
                <p className="text-sm text-foreground-muted">+{state.phone}</p>
              )}
              {state.checkedAt && (
                <p className="text-sm text-foreground-muted">
                  Last checked: {new Date(state.checkedAt).toLocaleString()}
                </p>
              )}
            </div>
          )}
          {state?.enabled === false && (
            <Notice variant="info">
              This project is not enabled for the Evolution pilot. New automated
              replies are disabled.
            </Notice>
          )}
          {state?.cleanupPending && (
            <Notice variant="warning">
              Sending is disabled. Retry disconnecting to finish removing the
              remote session.
            </Notice>
          )}
          {state?.state !== "open" && !state?.cleanupPending && (
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                  disabled={pending}
                />
                <span>
                  I understand the risk of restrictions or bans and authorize
                  connecting this number through Evolution.
                </span>
              </label>
              <Button
                disabled={!accepted || state?.enabled === false}
                loading={pending}
                onClick={pair}
              >
                {" "}
                {saved ? "Get a new QR code" : "Connect with QR code"}{" "}
              </Button>
              {pairing?.qr && (
                <div className="space-y-2">
                  <Image
                    src={pairing.qr}
                    alt="Scan this QR code with WhatsApp to connect your number"
                    width={256}
                    height={256}
                    unoptimized
                  />
                  <p className="text-sm text-foreground-muted">
                    Open WhatsApp → Linked devices → Link a device. The code is
                    hidden after 30 seconds; request a new one if needed.
                  </p>
                </div>
              )}
              {pairing && !pairing.qr && pairing.state !== "open" && (
                <Notice variant="info">
                  The session is preparing. Request a new QR code in a few
                  seconds.
                </Notice>
              )}
            </div>
          )}
          {saved && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                loading={pending}
                onClick={() =>
                  run(async () => {
                    await buildApi.call("build_refresh_evolution_connection", {
                      connectionId: saved.id,
                    })
                    setPairing(null)
                  })
                }
              >
                Check connection
              </Button>
              {state?.state === "open" && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      await buildApi.call("build_update_channel_status", {
                        connectionId: saved.id,
                        status:
                          state.status === "paused" ? "connected" : "paused",
                      })
                    })
                  }
                >
                  {state.status === "paused" ? "Resume agent" : "Pause agent"}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => setDisconnect(true)}
              >
                Disconnect
              </Button>
            </div>
          )}
          <p className="text-sm text-foreground-muted">
            This connection uses{" "}
            <a
              className="underline"
              href="https://github.com/evolution-foundation/evolution-api"
              target="_blank"
              rel="noreferrer"
            >
              Evolution API
            </a>
            . Datool is not endorsed by Evolution Foundation or Meta.
          </p>
        </CardContent>
      </Card>
      <Dialog open={disconnect} onOpenChange={setDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this number?</DialogTitle>
            <DialogDescription>
              Stops new replies, cancels queued sends and removes the Evolution
              session. Your Datool conversation history remains available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDisconnect(false)}
            >
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                run(async () => {
                  await buildApi.call("build_disconnect_evolution", {
                    connectionId: saved?.id,
                  })
                  setPairing(null)
                  setAccepted(false)
                  setDisconnect(false)
                })
              }
            >
              Disconnect number
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
