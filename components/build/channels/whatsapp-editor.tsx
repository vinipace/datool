"use client"

import * as React from "react"
import { EvolutionEditor } from "./evolution-editor"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  ExternalLink,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { FormRow } from "@/components/ui/form-row"
import { useRemote } from "@/components/tracer/hooks"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { AgentSidebarNavigation } from "@/components/build/shared/agent-sidebar"
import { buildApi } from "@/components/build/operations/build-api"
import {
  BuildStatus,
  BuildState,
} from "@/components/build/operations/build-page"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import type {
  WhatsAppMode,
  WhatsAppSetup,
  WhatsAppSignup,
} from "@/src/lib/build/whatsapp"

type MetaSdk = {
  init(options: Record<string, unknown>): void
  login(
    callback: (response: { authResponse?: { code?: string } }) => void,
    options: Record<string, unknown>
  ): void
}
type MetaWindow = Window & { FB?: MetaSdk }
let sdkPromise: Promise<MetaSdk> | undefined
function loadMetaSdk(setup: WhatsAppSetup): Promise<MetaSdk> {
  sdkPromise ??= new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sdkPromise = undefined
      reject(
        new Error(
          "Meta signup took too long to load. Check your connection and retry."
        )
      )
    }, 15_000)
    const ready = () => {
      clearTimeout(timeout)
      const sdk = (window as MetaWindow).FB
      if (!sdk) {
        sdkPromise = undefined
        reject(
          new Error(
            "Meta signup could not load. Check your browser privacy settings and retry."
          )
        )
        return
      }
      sdk.init({
        appId: setup.appId,
        version: setup.graphVersion,
        cookie: false,
        xfbml: false,
      })
      resolve(sdk)
    }
    if ((window as MetaWindow).FB) {
      ready()
      return
    }
    const script = document.createElement("script")
    script.src = "https://connect.facebook.net/en_US/sdk.js"
    script.async = true
    script.onload = ready
    script.onerror = () => {
      clearTimeout(timeout)
      sdkPromise = undefined
      script.remove()
      reject(
        new Error(
          "Meta signup could not load. Check your connection and retry."
        )
      )
    }
    document.head.appendChild(script)
  })
  return sdkPromise
}
type ConnectionInfo = {
  status: ChannelConnection["status"]
  account: {
    displayPhoneNumber: string
    verifiedName: string
    mode: string
    tokenExpiresAt: string | null
    sync: Record<string, unknown>
  } | null
}
type Template = {
  id: string
  name: string
  language: string
  status: string
  category: string
}

function MetaWhatsAppEditor({
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
  const [label, setLabel] = React.useState(connection?.label ?? "WhatsApp")
  const [mode, setMode] = React.useState<WhatsAppMode>("coexistence")
  const [signup, setSignup] = React.useState<WhatsAppSignup | null>(null)
  const [phone, setPhone] = React.useState("")
  const [pin, setPin] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [sdkReady, setSdkReady] = React.useState(false)
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [templateDraft, setTemplateDraft] = React.useState({
    name: "",
    language: "pt_BR",
    category: "UTILITY",
    text: "",
  })
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const busy = React.useRef(false)
  const createKey = React.useRef(crypto.randomUUID())
  const attempt = React.useRef<{
    active: boolean
    code?: string
    wabaId?: string
    processing?: boolean
    timer?: ReturnType<typeof setTimeout>
  }>({ active: false })
  const setup = useRemote(
    (signal) =>
      buildApi.call<WhatsAppSetup>("build_get_whatsapp_setup", {}, signal),
    []
  )
  const info = useRemote(
    (signal) =>
      buildApi.call<ConnectionInfo>(
        "build_get_whatsapp_connection",
        { connectionId: saved?.id },
        signal
      ),
    [saved?.id],
    { enabled: !!saved }
  )
  const connected = ["connected", "paused"].includes(
    info.data?.status ?? saved?.status ?? ""
  )
  const templates = useRemote(
    (signal) =>
      buildApi.call<{ items: Template[]; nextCursor: string | null }>(
        "build_list_whatsapp_templates",
        { connectionId: saved?.id },
        signal
      ),
    [saved?.id, connected],
    { enabled: connected }
  )
  const [extraTemplates, setExtraTemplates] = React.useState<Template[]>([])
  const [cursor, setCursor] = React.useState<string | null | undefined>(
    undefined
  )
  const agentHref = href(`/build/agents/${agent.id}`)
  const backHref = fromAgent
    ? `${agentHref}?section=channels`
    : href(`/build/integrations?agentId=${agent.id}`)
  async function run(action: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    setNotice(null)
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
    const sessionId = params.get("signup")
    if (!sessionId || !saved || !setup.data?.configured) return
    let active = true
    void buildApi
      .call<WhatsAppSignup>("build_get_whatsapp_signup", { sessionId })
      .then(async (session) => {
        if (session.connectionId !== saved.id)
          throw new Error("This signup belongs to another channel.")
        if (!active) return
        setSignup(session)
        setMode(session.mode)
        setPhone(session.phones[0]?.id ?? "")
        if (session.state === "pending") {
          await loadMetaSdk(session.setup)
          if (active) setSdkReady(true)
        }
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Could not resume signup."
          )
      })
    return () => {
      active = false
    }
  }, [params, saved, setup.data?.configured])
  React.useEffect(
    () => () => {
      attempt.current.active = false
      clearTimeout(attempt.current.timer)
    },
    []
  )
  const finish = React.useEffectEvent(async () => {
    const current = attempt.current
    if (!current.active || current.processing || !current.code || !signup)
      return
    current.processing = true
    clearTimeout(current.timer)
    await run(async () => {
      const authorized = await buildApi.call<WhatsAppSignup>(
        "build_authorize_whatsapp_signup",
        {
          sessionId: signup.id,
          code: current.code,
          ...(current.wabaId ? { wabaId: current.wabaId } : {}),
        }
      )
      current.code = undefined
      current.active = false
      setSignup(authorized)
      setPhone(authorized.phones[0]?.id ?? "")
    })
    current.code = undefined
    current.active = false
  })
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        ![
          "https://www.facebook.com",
          "https://web.facebook.com",
          "https://m.facebook.com",
        ].includes(event.origin) ||
        !attempt.current.active
      )
        return
      let payload: {
        type?: string
        event?: string
        data?: { waba_id?: string }
      }
      try {
        payload =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return
      if (
        [
          "FINISH",
          "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
          "FINISH_ONLY_WABA",
        ].includes(payload.event ?? "")
      ) {
        if (/^\d{5,30}$/.test(payload.data?.waba_id ?? ""))
          attempt.current.wabaId = payload.data?.waba_id
        void finish()
      } else if (payload.event === "CANCEL" || payload.event === "ERROR") {
        attempt.current.active = false
        clearTimeout(attempt.current.timer)
        setError(
          "Meta signup was not completed. You can start again when ready."
        )
      }
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])
  async function prepare() {
    await run(async () => {
      const target =
        saved ??
        (await buildApi.call<ChannelConnection>(
          "build_create_channel",
          {
            agentId: agent.id,
            channel: "whatsapp",
            label: label.trim() || "WhatsApp",
          },
          { idempotencyKey: createKey.current }
        ))
      setSaved(target)
      const session = await buildApi.call<WhatsAppSignup>(
        "build_begin_whatsapp_signup",
        { connectionId: target.id, mode }
      )
      await loadMetaSdk(session.setup)
      setSignup(session)
      setSdkReady(true)
      router.replace(
        href(
          `/build/integrations/${target.id}?agentId=${agent.id}&signup=${session.id}${fromAgent ? "&from=agent" : ""}`
        )
      )
    })
  }
  function openMeta() {
    const sdk = (window as MetaWindow).FB
    if (!sdk || !signup || !sdkReady) return
    setError(null)
    attempt.current = { active: true }
    // Keep FB.login in the direct click stack so browsers allow its popup.
    sdk.login(
      (response) => {
        if (!attempt.current.active) return
        const code = response.authResponse?.code
        if (!code) {
          attempt.current.active = false
          setError("Meta signup was cancelled or permission was not granted.")
          return
        }
        attempt.current.code = code
        // Session-info and OAuth callbacks can arrive in either order. The server
        // can discover a single granted WABA if no session-info event arrives.
        attempt.current.timer = setTimeout(() => {
          void finish()
        }, 1000)
      },
      {
        config_id: signup.setup.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          ...(signup.mode === "coexistence"
            ? { featureType: "whatsapp_business_app_onboarding" }
            : {}),
        },
      }
    )
  }
  async function activate() {
    if (!signup) return
    await run(async () => {
      await buildApi.call("build_activate_whatsapp_signup", {
        sessionId: signup.id,
        phoneNumberId: phone,
        ...(pin ? { pin } : {}),
      })
      setPin("")
      setSignup(null)
      info.refresh()
      templates.refresh()
      router.replace(
        href(
          `/build/integrations/${saved!.id}?agentId=${agent.id}${fromAgent ? "&from=agent" : ""}`
        )
      )
      setNotice(
        "WhatsApp is connected. Send a message to your business number to test the agent."
      )
    })
  }
  async function changeStatus(status: string) {
    if (!saved) return
    await run(async () => {
      await buildApi.call("build_update_channel_status", {
        connectionId: saved.id,
        status,
      })
      info.refresh()
    })
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {fromAgent && (
        <AgentSidebarNavigation
          name={agent.name}
          active="channels"
          canConfigure
          agentHref={agentHref}
          agentId={agent.id}
          appearance={agent.configuration.appearance}
          onChange={(section) => router.push(`${agentHref}?section=${section}`)}
        />
      )}
      <HeaderSlot name="title">
        <div className="flex min-w-0 items-center gap-2">
          <ChannelIcon channel="whatsapp" className="size-7" />
          <h1 className="truncate text-sm font-medium">
            {saved?.label ?? "Set up WhatsApp"}
          </h1>
        </div>
      </HeaderSlot>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref}>
            <ArrowLeft />
            Channels
          </Link>
        </Button>
        {saved && <BuildStatus status={info.data?.status ?? saved.status} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          {notice && (
            <Notice variant="success" role="status">
              {notice}
            </Notice>
          )}
          <BuildState
            isLoading={setup.isLoading || (!!saved && info.isLoading)}
            error={setup.error ?? info.error}
            onRetry={() => {
              setup.refresh()
              info.refresh()
            }}
          >
            {!setup.data?.configured && (
              <Notice title="WhatsApp setup required">
                An administrator needs to configure Meta before you can connect
                a number.{" "}
                <Link className="underline" href="/docs/guides/whatsapp">
                  View setup instructions
                </Link>
              </Notice>
            )}
            {!connected || signup ? (
              <Card>
                <CardHeader>
                  <CardTitle>Connect your business number</CardTitle>
                  <CardDescription>
                    Choose how you use WhatsApp. Meta will ask you to authorize
                    your business and verify your number.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!saved && (
                    <FormRow
                      label="Channel name"
                      htmlFor="whatsapp-label"
                      layout="vertical"
                    >
                      <Input
                        id="whatsapp-label"
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                        maxLength={200}
                      />
                    </FormRow>
                  )}
                  <FormRow
                    label="Connection type"
                    htmlFor="whatsapp-mode"
                    layout="vertical"
                  >
                    <Select
                      id="whatsapp-mode"
                      value={mode}
                      disabled={pending || signup?.state === "authorized"}
                      onChange={(event) => {
                        setMode(event.target.value as WhatsAppMode)
                        setSignup(null)
                        setSdkReady(false)
                      }}
                    >
                      <option value="coexistence">
                        Keep using the WhatsApp Business App
                      </option>
                      <option value="cloud">
                        Connect a number for the Cloud API
                      </option>
                    </Select>
                  </FormRow>
                  <p className="text-sm text-foreground-muted">
                    {mode === "coexistence"
                      ? "Keep your Business App and connect the agent to the same number. When your team replies from the app, the conversation moves to human control in Datool. Meta determines number eligibility."
                      : "Connect a dedicated business number. Meta may ask you to verify it by SMS or a phone call."}
                  </p>
                  {signup?.state === "authorized" ? (
                    <>
                      <FormRow
                        label="Business number"
                        htmlFor="whatsapp-phone"
                        layout="vertical"
                      >
                        <Select
                          id="whatsapp-phone"
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                        >
                          {signup.phones.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.display_phone_number} —{" "}
                              {item.verified_name || "Business number"}
                            </option>
                          ))}
                        </Select>
                      </FormRow>
                      {mode === "cloud" && (
                        <FormRow
                          label="Existing two-step verification PIN (optional)"
                          htmlFor="whatsapp-pin"
                          layout="vertical"
                        >
                          <Input
                            id="whatsapp-pin"
                            type="password"
                            autoComplete="off"
                            inputMode="numeric"
                            maxLength={6}
                            value={pin}
                            onChange={(event) =>
                              setPin(event.target.value.replace(/\D/g, ""))
                            }
                          />
                        </FormRow>
                      )}
                      <Button
                        loading={pending}
                        disabled={!phone || (!!pin && pin.length !== 6)}
                        onClick={() => void activate()}
                      >
                        Connect number
                      </Button>
                    </>
                  ) : signup?.state === "pending" && sdkReady ? (
                    <div className="flex flex-wrap gap-2">
                      <Button loading={pending} onClick={openMeta}>
                        Continue with Meta
                        <ExternalLink />
                      </Button>
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => void prepare()}
                      >
                        Start again
                      </Button>
                    </div>
                  ) : (
                    <Button
                      loading={pending}
                      disabled={!setup.data?.configured || !label.trim()}
                      onClick={() => void prepare()}
                    >
                      {saved ? "Reconnect WhatsApp" : "Set up connection"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {info.data?.account?.displayPhoneNumber}
                    </CardTitle>
                    <CardDescription>
                      {info.data?.account?.verifiedName} ·{" "}
                      {info.data?.account?.mode === "coexistence"
                        ? "Business App + Datool"
                        : "Cloud API"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={pending}
                      onClick={() =>
                        void run(async () => {
                          await buildApi.call(
                            "build_refresh_whatsapp_connection",
                            { connectionId: saved!.id }
                          )
                          setNotice("Meta authorization is working.")
                          info.refresh()
                        })
                      }
                    >
                      <RefreshCw />
                      Check connection
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        void changeStatus(
                          info.data?.status === "paused"
                            ? "connected"
                            : "paused"
                        )
                      }
                    >
                      {info.data?.status === "paused" ? <Play /> : <Pause />}
                      {info.data?.status === "paused" ? "Resume" : "Pause"}
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={`https://wa.me/${info.data?.account?.displayPhoneNumber.replace(/\D/g, "")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Send a test message
                        <ExternalLink />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setDisconnectOpen(true)}
                    >
                      <Unplug />
                      Disconnect
                    </Button>
                  </CardContent>
                </Card>
                {info.data?.account?.mode === "coexistence" && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Business App history</CardTitle>
                      <CardDescription>
                        Import conversations or contacts you agreed to share
                        during Meta signup. Imported messages won’t trigger
                        agent replies. Meta allows initial sync within 24 hours
                        of connecting.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      {(
                        [
                          ["history", "Import shared history"],
                          ["smb_app_state_sync", "Import shared contacts"],
                        ] as const
                      ).map(([type, title]) => (
                        <Button
                          key={type}
                          variant="outline"
                          size="sm"
                          loading={pending}
                          disabled={!!info.data?.account?.sync[type]}
                          onClick={() =>
                            void run(async () => {
                              await buildApi.call("build_sync_whatsapp_app", {
                                connectionId: saved!.id,
                                type,
                                consent: true,
                              })
                              info.refresh()
                              setNotice(
                                "Import requested. Updates will appear as Meta sends them."
                              )
                            })
                          }
                        >
                          {info.data?.account?.sync[type]
                            ? `${type === "history" ? "History" : "Contacts"} import requested`
                            : title}
                        </Button>
                      ))}
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>Message templates</CardTitle>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setTemplateOpen(true)}
                      >
                        <Plus />
                        New template
                      </Button>
                    </div>
                    <CardDescription>
                      Use approved templates to contact customers outside the
                      24-hour reply window. Record their permission before
                      sending.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <BuildState
                      isLoading={templates.isLoading}
                      error={templates.error}
                      onRetry={templates.refresh}
                    >
                      {[...(templates.data?.items ?? []), ...extraTemplates]
                        .length ? (
                        <div className="divide-y divide-border">
                          {[
                            ...(templates.data?.items ?? []),
                            ...extraTemplates,
                          ].map((item) => (
                            <div
                              key={item.id}
                              className="flex flex-wrap items-center justify-between gap-2 py-3"
                            >
                              <div>
                                <p className="text-sm font-medium">
                                  {item.name}
                                </p>
                                <p className="text-xs text-foreground-muted">
                                  {item.language} · {item.category}
                                </p>
                              </div>
                              <BuildStatus status={item.status.toLowerCase()} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="py-4 text-sm text-foreground-muted">
                          No templates yet. Create one to submit it to Meta for
                          approval.
                        </p>
                      )}
                      {(cursor === undefined
                        ? templates.data?.nextCursor
                        : cursor) && (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={pending}
                          onClick={() =>
                            void run(async () => {
                              const next = await buildApi.call<{
                                items: Template[]
                                nextCursor: string | null
                              }>("build_list_whatsapp_templates", {
                                connectionId: saved!.id,
                                after: cursor ?? templates.data?.nextCursor,
                              })
                              setExtraTemplates((current) => [
                                ...current,
                                ...next.items,
                              ])
                              setCursor(next.nextCursor)
                            })
                          }
                        >
                          Load more
                        </Button>
                      )}
                    </BuildState>
                  </CardContent>
                </Card>
              </>
            )}
          </BuildState>
        </div>
      </div>
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect WhatsApp?</DialogTitle>
            <DialogDescription>
              Datool will stop this channel and remove its saved credentials.
              Your WhatsApp Business App will remain available.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={() =>
                void run(async () => {
                  await buildApi.call("build_disconnect_whatsapp", {
                    connectionId: saved!.id,
                  })
                  setDisconnectOpen(false)
                  info.refresh()
                  setNotice("WhatsApp disconnected.")
                })
              }
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                  connectionId: saved!.id,
                  name: templateDraft.name,
                  language: templateDraft.language,
                  category: templateDraft.category,
                  components: [{ type: "BODY", text: templateDraft.text }],
                })
                setTemplateOpen(false)
                setExtraTemplates([])
                setCursor(undefined)
                templates.refresh()
                setNotice("Template submitted to Meta for review.")
              })
            }}
          >
            <FormRow label="Name" htmlFor="wa-template-name" layout="vertical">
              <Input
                id="wa-template-name"
                required
                pattern="[a-z0-9_]+"
                placeholder="order_update"
                value={templateDraft.name}
                onChange={(event) =>
                  setTemplateDraft({
                    ...templateDraft,
                    name: event.target.value,
                  })
                }
              />
            </FormRow>
            <FormRow
              label="Language"
              htmlFor="wa-template-language"
              layout="vertical"
            >
              <Select
                id="wa-template-language"
                value={templateDraft.language}
                onChange={(event) =>
                  setTemplateDraft({
                    ...templateDraft,
                    language: event.target.value,
                  })
                }
              >
                <option value="pt_BR">Portuguese (Brazil)</option>
                <option value="en_US">English (US)</option>
                <option value="es">Spanish</option>
              </Select>
            </FormRow>
            <FormRow
              label="Category"
              htmlFor="wa-template-category"
              layout="vertical"
            >
              <Select
                id="wa-template-category"
                value={templateDraft.category}
                onChange={(event) =>
                  setTemplateDraft({
                    ...templateDraft,
                    category: event.target.value,
                  })
                }
              >
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
              </Select>
            </FormRow>
            <FormRow
              label="Message"
              htmlFor="wa-template-body"
              layout="vertical"
            >
              <Textarea
                id="wa-template-body"
                required
                maxLength={1024}
                value={templateDraft.text}
                onChange={(event) =>
                  setTemplateDraft({
                    ...templateDraft,
                    text: event.target.value,
                  })
                }
              />
            </FormRow>
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setTemplateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Submit to Meta
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function WhatsAppEditor(props: { connection: ChannelConnection | null; agent: ManagedAgent; fromAgent: boolean }) {
  const [provider, setProvider] = React.useState<string | null>(props.connection ? String(props.connection.config.provider ?? "meta") : null)
  const setup = useRemote(signal => buildApi.call<{ enabled: boolean }>("build_get_evolution_setup", {}, signal), [])
  if (provider === "evolution") return <EvolutionEditor {...props} />
  if (provider === "meta") return <MetaWhatsAppEditor {...props} />
  return <Card><CardHeader><CardTitle>Connect WhatsApp</CardTitle><CardDescription>Choose how to connect your business number.</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="space-y-2"><Button onClick={() => setProvider("meta")}>Official Meta API</Button><p className="text-sm text-foreground-muted">Connect through Meta's official business platform.</p></div>
    {setup.data?.enabled && <div className="space-y-2"><Button variant="outline" onClick={() => setProvider("evolution")}>Evolution · Unofficial connection</Button><p className="text-sm text-foreground-muted">Scan a QR code. This connection carries a risk of account restrictions or bans.</p></div>}
    {setup.error && <Notice variant="error">Could not check connection options. <Button variant="outline" size="sm" onClick={setup.refresh}>Retry</Button></Notice>}
  </CardContent></Card>
}
