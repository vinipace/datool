"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Notice } from "@/components/ui/notice"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { buildApi } from "@/components/build/operations/build-api"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import type { WhatsAppMode } from "@/src/lib/build/whatsapp"

type ConnectionInfo = {
  configured: boolean
  status: ChannelConnection["status"]
  account: { displayPhoneNumber: string; mode: string } | null
}

export function ZernioEditor({
  connection,
  agent,
  fromAgent,
}: {
  connection: ChannelConnection | null
  agent: ManagedAgent
  fromAgent: boolean
}) {
  const router = useRouter(),
    params = useSearchParams(),
    href = useWorkspaceHref()
  const [saved, setSaved] = React.useState(connection)
  const [mode, setMode] = React.useState<WhatsAppMode>("coexistence")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [template, setTemplate] = React.useState({
    name: "",
    language: "pt_BR",
    category: "UTILITY",
    text: "",
  })
  const busy = React.useRef(false),
    callbackStarted = React.useRef(false),
    createKey = React.useRef(crypto.randomUUID())
  const info = useRemote(
    (signal) =>
      buildApi.call<ConnectionInfo>(
        "build_get_zernio_whatsapp",
        { connectionId: saved?.id },
        signal
      ),
    [saved?.id],
    { enabled: !!saved }
  )
  const status = info.data?.status ?? saved?.status
  const connected = status === "connected" || status === "paused"
  const templates = useRemote(
    (signal) =>
      buildApi.call<{
        items: Array<{
          id: string
          name: string
          language: string
          status: string
        }>
      }>("build_list_whatsapp_templates", { connectionId: saved?.id }, signal),
    [saved?.id, connected],
    { enabled: connected }
  )
  const backHref = fromAgent
    ? `${href(`/build/agents/${agent.id}`)}?section=channels`
    : href(`/build/integrations?agentId=${agent.id}`)
  async function run(action: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "WhatsApp setup failed. Try again."
      )
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  React.useEffect(() => {
    const signupId = params.get("zernioSignup"),
      accountId = params.get("accountId"),
      providerError = params.get("error")
    if (!saved || !signupId || callbackStarted.current) return
    callbackStarted.current = true
    if (providerError || !accountId) {
      queueMicrotask(() =>
        setError(
          "WhatsApp setup was cancelled or could not be completed. Please try again."
        )
      )
      router.replace(
        href(`/build/integrations/${saved.id}?agentId=${agent.id}`)
      )
      return
    }
    queueMicrotask(
      () =>
        void run(async () => {
          await buildApi.call("build_finish_zernio_whatsapp", {
            connectionId: saved.id,
            signupId,
            accountId,
          })
          router.replace(
            href(`/build/integrations/${saved.id}?agentId=${agent.id}`)
          )
          info.refresh()
        })
    )
    // A callback must be processed only once, even if the remote state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id, params])
  async function connect() {
    await run(async () => {
      const target =
        saved ??
        (await buildApi.call<ChannelConnection>(
          "build_create_channel",
          {
            agentId: agent.id,
            channel: "whatsapp",
            label: "WhatsApp",
            config: { provider: "zernio" },
          },
          { idempotencyKey: createKey.current }
        ))
      setSaved(target)
      const result = await buildApi.call<{ authUrl: string }>(
        "build_begin_zernio_whatsapp",
        { connectionId: target.id, mode }
      )
      window.location.assign(result.authUrl)
    })
  }
  return (
    <div className="space-y-6">
      <Link
        href={backHref}
        className="text-sm text-foreground-muted hover:text-foreground"
      >
        ← Back to channels
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>WhatsApp</CardTitle>
          <CardDescription>
            Connect your business number through the official WhatsApp Business
            Platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && <Notice variant="error">{error}</Notice>}
          {info.error && (
            <Notice variant="error">
              Could not check the connection.{" "}
              <Button variant="outline" size="sm" onClick={info.refresh}>
                Retry
              </Button>
            </Notice>
          )}
          {info.data?.configured === false && (
            <Notice variant="warning">
              WhatsApp is not configured on this installation yet.
            </Notice>
          )}
          {connected ? (
            <div className="space-y-4">
              <div>
                <p className="font-medium">
                  {status === "paused" ? "Paused" : "Connected"}
                </p>
                <p className="text-sm text-foreground-muted">
                  {info.data?.account?.displayPhoneNumber ||
                    "WhatsApp Business"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await buildApi.call("build_update_channel_status", {
                        connectionId: saved?.id,
                        status: status === "paused" ? "connected" : "paused",
                      })
                      info.refresh()
                    })
                  }
                >
                  {status === "paused" ? "Resume" : "Pause"}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="whatsapp-mode" className="text-sm font-medium">
                  How would you like to use this number?
                </label>
                <Select
                  id="whatsapp-mode"
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as WhatsAppMode)
                  }
                >
                  <option value="coexistence">
                    Keep using the WhatsApp Business app
                  </option>
                  <option value="cloud">
                    Use the WhatsApp Business Platform only
                  </option>
                </Select>
                <p className="text-sm text-foreground-muted">
                  Meta will guide you through connecting your number. You may
                  need a Meta Business account.
                </p>
              </div>
              <Button
                disabled={pending || info.data?.configured === false}
                loading={pending}
                onClick={() => void connect()}
              >
                Connect with Meta
              </Button>
            </div>
          )}
          {connected && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">Message templates</p>
                  <p className="text-sm text-foreground-muted">
                    Meta reviews templates before they can be used outside the
                    reply window.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTemplateOpen(true)}
                >
                  New template
                </Button>
              </div>
              {templates.error ? (
                <Notice variant="error">
                  Could not load templates.{" "}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={templates.refresh}
                  >
                    Retry
                  </Button>
                </Notice>
              ) : templates.data?.items.length ? (
                <ul className="space-y-2">
                  {templates.data.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex justify-between gap-4 text-sm"
                    >
                      <span>
                        {item.name} · {item.language}
                      </span>
                      <span className="text-foreground-muted">
                        {item.status}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-foreground-muted">
                  No templates yet.
                </p>
              )}
            </div>
          )}
          <p className="text-sm text-foreground-muted">
            WhatsApp policies, messaging fees and the 24-hour reply window
            apply.
          </p>
        </CardContent>
      </Card>
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New message template</DialogTitle>
            <DialogDescription>
              Meta reviews templates before they can be sent.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await buildApi.call("build_create_whatsapp_template", {
                  connectionId: saved?.id,
                  name: template.name,
                  language: template.language,
                  category: template.category,
                  components: [{ type: "BODY", text: template.text }],
                })
                setTemplateOpen(false)
                templates.refresh()
              })
            }}
          >
            <label className="block space-y-1 text-sm">
              Name
              <Input
                required
                pattern="[a-z0-9_]+"
                value={template.name}
                onChange={(event) =>
                  setTemplate({ ...template, name: event.target.value })
                }
              />
            </label>
            <label className="block space-y-1 text-sm">
              Language
              <Input
                required
                value={template.language}
                onChange={(event) =>
                  setTemplate({ ...template, language: event.target.value })
                }
              />
            </label>
            <label className="block space-y-1 text-sm">
              Category
              <Select
                value={template.category}
                onChange={(event) =>
                  setTemplate({ ...template, category: event.target.value })
                }
              >
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Authentication</option>
              </Select>
            </label>
            <label className="block space-y-1 text-sm">
              Message
              <Textarea
                required
                value={template.text}
                onChange={(event) =>
                  setTemplate({ ...template, text: event.target.value })
                }
              />
            </label>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setTemplateOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={pending} type="submit">
                Submit for review
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect WhatsApp?</DialogTitle>
            <DialogDescription>
              Datool will stop receiving and sending messages for this channel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await buildApi.call("build_disconnect_zernio_whatsapp", {
                    connectionId: saved?.id,
                  })
                  setDisconnectOpen(false)
                  info.refresh()
                })
              }
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
