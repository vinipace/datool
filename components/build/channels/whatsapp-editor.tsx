"use client"

import * as React from "react"
import { EvolutionEditor } from "./evolution-editor"
import { ZernioEditor } from "./zernio-editor"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  ArrowUpRight,
  Smartphone,
  Cloud,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Unplug,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { RadioCard } from "@/components/ui/radio-card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsSection } from "@/components/ui/settings-section"
import { WhatsAppPreview } from "./whatsapp-preview"
import { cn } from "@/lib/utils"
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

export function MetaWhatsAppEditor({
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
  const [settingsOpen, setSettingsOpen] = React.useState(true)
  const settingsId = React.useId()
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
  const isLoading = setup.isLoading || (!!saved && info.isLoading)
  const loadError = setup.error ?? info.error
  const status = info.data?.status ?? saved?.status
  const businessPhone = info.data?.account?.displayPhoneNumber
  const testNumber = businessPhone?.replace(/\D/g, "")
  const businessName = info.data?.account?.verifiedName || agent.name
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
      const readiness = await buildApi.call<WhatsAppSetup>(
        "build_get_whatsapp_setup",
        {}
      )
      if (!readiness.configured) {
        throw new Error(
          "WhatsApp isn’t configured on this Datool installation. Add the Meta credentials and public webhook URL, then try again."
        )
      }
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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={backHref}>
              <ArrowLeft />
              Channels
            </Link>
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            Configuration
          </Button>
        </div>
        {saved &&
          (info.error ? (
            <span className="text-xs text-foreground-muted">
              Status unavailable
            </span>
          ) : info.isLoading ? (
            <span role="status" className="text-xs text-foreground-muted">
              Checking connection…
            </span>
          ) : (
            <BuildStatus status={status ?? saved.status} />
          ))}
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:overflow-hidden",
          settingsOpen && "lg:grid-cols-[24rem_minmax(0,1fr)]"
        )}
      >
        <aside
          id={settingsId}
          hidden={!settingsOpen}
          aria-label="WhatsApp configuration"
          className="min-w-0 [scrollbar-width:thin] border-b border-border bg-background lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <div className="flex items-center gap-3 px-5 py-5">
            <ChannelIcon channel="whatsapp" className="size-9" />
            <div>
              <h2 className="text-sm font-semibold">WhatsApp</h2>
              <p className="mt-0.5 text-xs text-foreground-muted">
                Business channel
              </p>
            </div>
          </div>
          {(error || notice) && (
            <div className="space-y-3 px-4 pb-4">
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
            </div>
          )}
          <div className="px-5 pb-6">
            {isLoading ? (
              <div
                role="status"
                aria-label="Loading WhatsApp configuration"
                className="space-y-6 py-4"
              >
                <Skeleton className="h-4 w-24" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
                <Skeleton className="h-28 w-full" />
              </div>
            ) : (
              <BuildState
                isLoading={false}
                error={loadError}
                onRetry={() => {
                  setup.refresh()
                  info.refresh()
                }}
              >
                {!connected || signup ? (
                  <section aria-labelledby="whatsapp-setup-heading">
                    <div className="mb-6 space-y-1.5">
                      <h3
                        id="whatsapp-setup-heading"
                        className="text-base font-semibold"
                      >
                        Connect WhatsApp
                      </h3>
                      <p className="text-xs leading-5 text-foreground-muted">
                        Let your agent respond on your business number.
                      </p>
                    </div>
                    <div className="space-y-6">
                      {!saved && (
                        <FormRow
                          label="Channel name"
                          htmlFor="whatsapp-label"
                          layout="vertical"
                          variant="plain"
                        >
                          <Input
                            id="whatsapp-label"
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            maxLength={200}
                          />
                        </FormRow>
                      )}
                      <fieldset
                        className="min-w-0 space-y-2"
                        disabled={pending || signup?.state === "authorized"}
                      >
                        <legend className="mb-3 text-sm font-medium">
                          How will you use WhatsApp?
                        </legend>
                        {(
                          [
                            {
                              value: "coexistence",
                              title: "Keep my Business App",
                              description:
                                "Use your existing number with the app and your agent.",
                              icon: Smartphone,
                            },
                            {
                              value: "cloud",
                              title: "Use a dedicated number",
                              description:
                                "Connect a number directly to your agent through Meta.",
                              icon: Cloud,
                            },
                          ] as const
                        ).map((option) => (
                          <RadioCard
                            key={option.value}
                            name="whatsapp-mode"
                            value={option.value}
                            checked={mode === option.value}
                            onChange={() => {
                              setMode(option.value)
                              setSignup(null)
                              setSdkReady(false)
                            }}
                            aria-label={option.title}
                          >
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <option.icon
                                className="size-4 shrink-0"
                                aria-hidden="true"
                              />
                              {option.title}
                            </div>
                            <p className="mt-1.5 text-xs leading-5 text-foreground-muted">
                              {option.description}
                            </p>
                          </RadioCard>
                        ))}
                        <p className="pt-1 text-xs leading-5 text-foreground-muted">
                          {mode === "coexistence"
                            ? "Your team can still reply in the app. Those conversations switch to human control in Datool."
                            : "Have access to this number for Meta’s SMS or phone verification."}
                        </p>
                      </fieldset>
                      <div className="space-y-3">
                        <p className="text-xs leading-5 text-foreground-muted">
                          Next, authorize your business with Meta and verify
                          your number. Meta determines eligibility.
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
                                onChange={(event) =>
                                  setPhone(event.target.value)
                                }
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
                                    setPin(
                                      event.target.value.replace(/\D/g, "")
                                    )
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
                            disabled={!label.trim()}
                            className="w-full"
                            onClick={() => void prepare()}
                          >
                            {saved ? "Reconnect WhatsApp" : "Connect with Meta"}
                            <ArrowUpRight />
                          </Button>
                        )}
                      </div>
                    </div>
                  </section>
                ) : (
                  <>
                    <Card className="overflow-hidden rounded-lg">
                      <div className="flex items-start justify-between gap-3 p-4">
                        <div className="min-w-0 space-y-1">
                          <p className="text-xs text-foreground-muted">
                            Business number
                          </p>
                          <p className="text-sm font-medium break-words tabular-nums">
                            {businessPhone || "Number unavailable"}
                          </p>
                          <p
                            className="truncate text-xs text-foreground-muted"
                            title={businessName}
                          >
                            {businessName}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost-muted"
                              size="icon-sm"
                              aria-label="Connection actions"
                              disabled={pending}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() =>
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
                              <RefreshCw /> Check connection
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDisconnectOpen(true)}
                            >
                              <Unplug /> Disconnect
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs">
                        <span className="text-foreground-muted">
                          Connection
                        </span>
                        <span>
                          {info.data?.account?.mode === "coexistence"
                            ? "Business App + Datool"
                            : "Cloud API"}
                        </span>
                      </div>
                    </Card>
                    <div className="flex items-start justify-between gap-4 py-5">
                      <div className="space-y-1">
                        <label
                          htmlFor="whatsapp-agent-replies"
                          className="text-sm font-medium"
                        >
                          Agent replies
                        </label>
                        <p
                          id="whatsapp-agent-replies-description"
                          className="text-xs leading-5 text-foreground-muted"
                        >
                          {status === "paused"
                            ? "Paused. Turn on to resume automatic replies."
                            : `Automatically reply with ${agent.name}.`}
                        </p>
                      </div>
                      <Switch
                        id="whatsapp-agent-replies"
                        aria-describedby="whatsapp-agent-replies-description"
                        checked={status === "connected"}
                        disabled={pending || info.isRefreshing}
                        onCheckedChange={(enabled) =>
                          void changeStatus(enabled ? "connected" : "paused")
                        }
                      />
                    </div>
                    {info.data?.account?.mode === "coexistence" && (
                      <SettingsSection
                        title="Business App history"
                        density="compact"
                        defaultOpen={false}
                      >
                        <p className="mb-4 text-xs leading-5 text-foreground-muted">
                          Import conversations or contacts you agreed to share
                          during Meta signup. Imported messages won’t trigger
                          agent replies. Meta allows initial sync within 24
                          hours of connecting.
                        </p>
                        <div className="flex flex-wrap gap-2">
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
                                  await buildApi.call(
                                    "build_sync_whatsapp_app",
                                    {
                                      connectionId: saved!.id,
                                      type,
                                      consent: true,
                                    }
                                  )
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
                        </div>
                      </SettingsSection>
                    )}
                    <section
                      aria-label="Message templates"
                      className="border-t border-border pt-5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-medium">
                          Message templates
                        </h3>
                        <Button
                          size="sm"
                          variant="ghost-muted"
                          aria-label="New template"
                          onClick={() => setTemplateOpen(true)}
                        >
                          <Plus /> New
                        </Button>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-foreground-muted">
                        Approved messages for contacting customers after 24
                        hours. Customer permission required.
                      </p>
                      <div className="mt-3">
                        <BuildState
                          isLoading={templates.isLoading}
                          error={templates.error}
                          onRetry={templates.refresh}
                        >
                          {[...(templates.data?.items ?? []), ...extraTemplates]
                            .length ? (
                            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/40">
                              {[
                                ...(templates.data?.items ?? []),
                                ...extraTemplates,
                              ].map((item) => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-3 px-3 py-3"
                                >
                                  <div className="min-w-0">
                                    <p
                                      className="truncate text-xs font-medium"
                                      title={item.name}
                                    >
                                      {item.name}
                                    </p>
                                    <p className="text-xs text-foreground-muted">
                                      {item.language.replace("_", "-")} ·{" "}
                                      {item.category.charAt(0) +
                                        item.category.slice(1).toLowerCase()}
                                    </p>
                                  </div>
                                  <BuildStatus
                                    status={item.status.toLowerCase()}
                                  />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-border bg-muted/40 px-3 py-4">
                              <p className="text-xs font-medium">
                                No templates yet
                              </p>
                              <p className="mt-1 text-xs leading-5 text-foreground-muted">
                                Create your first template and submit it to Meta
                                for review.
                              </p>
                            </div>
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
                      </div>
                    </section>
                  </>
                )}
              </BuildState>
            )}
          </div>
        </aside>
        <section
          aria-label="WhatsApp preview"
          className="flex min-w-0 flex-col bg-muted/30 lg:overflow-y-auto"
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-6 py-4">
            <div>
              <h2 className="text-sm font-medium">Customer preview</h2>
              <p className="mt-1 text-xs text-foreground-muted">
                Test your agent in a WhatsApp-style conversation
              </p>
            </div>
            {connected && testNumber && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`https://wa.me/${testNumber}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in WhatsApp <ExternalLink />
                </a>
              </Button>
            )}
          </div>
          <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8">
            <WhatsAppPreview
              name={businessName}
              phoneNumber={businessPhone}
              agentId={agent.id}
              channelId={saved?.id ?? `whatsapp-preview:${agent.id}`}
            />
          </div>
        </section>
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

export function WhatsAppEditor(props: {
  connection: ChannelConnection | null
  agent: ManagedAgent
  fromAgent: boolean
}) {
  const [provider, setProvider] = React.useState<string | null>(
    props.connection ? String(props.connection.config.provider ?? "meta") : null
  )
  const setup = useRemote(
    (signal) =>
      buildApi.call<{ enabled: boolean }>(
        "build_get_evolution_setup",
        {},
        signal
      ),
    []
  )
  if (provider === "evolution") return <EvolutionEditor {...props} />
  if (provider === "meta") return <MetaWhatsAppEditor {...props} />
  if (provider === "zernio") return <ZernioEditor {...props} />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect WhatsApp</CardTitle>
        <CardDescription>
          Choose how to connect your business number.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Button onClick={() => setProvider("zernio")}>
            Official Meta API
          </Button>
          <p className="text-sm text-foreground-muted">
            Connect through Meta's official business platform.
          </p>
        </div>
        {setup.data?.enabled && (
          <div className="space-y-2">
            <Button variant="outline" onClick={() => setProvider("evolution")}>
              Evolution · Unofficial connection
            </Button>
            <p className="text-sm text-foreground-muted">
              Scan a QR code. This connection carries a risk of account
              restrictions or bans.
            </p>
          </div>
        )}
        {setup.error && (
          <Notice variant="error">
            Could not check connection options.{" "}
            <Button variant="outline" size="sm" onClick={setup.refresh}>
              Retry
            </Button>
          </Notice>
        )}
      </CardContent>
    </Card>
  )
}
