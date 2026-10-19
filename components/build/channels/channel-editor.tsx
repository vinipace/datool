"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  MessageCircle,
  Pause,
  Play,
  RefreshCw,
  Save,
  Send,
  Unplug,
  Wifi,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useRemote, useMutation } from "@/components/tracer/hooks"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { AgentSidebarNavigation } from "@/components/build/shared/agent-sidebar"
import {
  ChannelIcon,
  ChannelIdentity,
} from "@/components/build/shared/channel-identity"
import { channelLabel } from "@/components/build/shared/channel-catalog"
import { buildApi } from "@/components/build/operations/build-api"
import {
  BuildEmpty,
  BuildState,
  BuildStatus,
  FormLabel,
} from "@/components/build/operations/build-page"
import { ChatBubbleEditor } from "./chat-bubble-editor"
import { WhatsAppEditor } from "./whatsapp-editor"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"

type EditorData = { connection: ChannelConnection | null; agent: ManagedAgent }
type SupportedChannel = "web" | "telegram"

function originsOf(connection: ChannelConnection | null): string[] {
  const origins = connection?.config.originAllowlist
  return Array.isArray(origins)
    ? origins.filter((value): value is string => typeof value === "string")
    : []
}
function modeOf(connection: ChannelConnection | null) {
  if (!connection) return "polling"
  return connection?.config.mode === "polling" ? "polling" : "webhook"
}
function formatWhen(value: string | null) {
  return value ? new Date(value).toLocaleString() : "No activity yet"
}

export function ChannelEditorPage({ connectionId }: { connectionId?: string }) {
  const params = useSearchParams()
  const router = useRouter()
  const [creationKey] = React.useState(() => crypto.randomUUID())
  const agentId = params.get("agentId") || ""
  const channel = params.get("channel") || "web"
  const isWeb = channel === "web" || channel === "help_page"
  const workspaceHref = useWorkspaceHref()
  const state = useRemote(
    async (signal) => {
      let connection = connectionId
        ? (
            await buildApi.call<{ connection: ChannelConnection }>(
              "build_get_channel",
              { connectionId },
              signal
            )
          ).connection
        : null
      if (connection && agentId && connection.agentId !== agentId)
        throw new Error("This channel belongs to a different agent.")
      if (!connection && !agentId)
        throw new Error(
          "Select an agent from Channels before setting up a connection."
        )
      const kind = connection?.channel ?? channel
      if (kind !== "web" && kind !== "help_page" && kind !== "telegram" && kind !== "whatsapp")
        throw new Error("Setup is not available for this channel yet.")
      const agent = await buildApi.call<ManagedAgent>(
        "build_get_agent",
        { agentId: connection?.agentId ?? agentId },
        signal
      )
      if (!connection && isWeb) {
        connection = await buildApi.call<ChannelConnection>(
          "build_create_channel",
          {
            agentId: agent.id,
            channel: "web",
            label: channel === "help_page" ? "Help Page" : "Chat Bubble",
            config:
              channel === "help_page"
                ? {
                    bubble: {
                      layout: "help_page",
                      welcomeMessage: "How can I help you today?",
                      inputPlaceholder: "Ask me anything…",
                    },
                  }
                : {},
          },
          { signal, idempotencyKey: creationKey }
        )
      }
      return { connection, agent }
    },
    [connectionId, agentId, channel, isWeb, creationKey]
  )
  const data =
    state.data &&
    (state.data.connection?.id === connectionId || (!connectionId && isWeb)) &&
    (!agentId || state.data.agent.id === agentId)
      ? state.data
      : null
  React.useEffect(() => {
    if (connectionId || !isWeb || !data?.connection) return
    const query = new URLSearchParams({ agentId: data.agent.id })
    if (params.get("from") === "agent") query.set("from", "agent")
    router.replace(
      workspaceHref(`/build/integrations/${data.connection.id}?${query}`)
    )
  }, [connectionId, isWeb, data, params, router, workspaceHref])
  return (
    <BuildState
      isLoading={
        state.isLoading ||
        (!data && !state.error) ||
        (!connectionId && isWeb && !state.error)
      }
      error={state.error}
      onRetry={state.refresh}
    >
      {data?.connection?.channel === "web" ? (
        <ChatBubbleEditor
          key={data.connection.id}
          connection={data.connection}
          agent={data.agent}
          fromAgent={params.get("from") === "agent"}
        />
      ) : data && (data.connection?.channel ?? channel) === "whatsapp" ? (
        <WhatsAppEditor key={data.connection?.id ?? "new"} connection={data.connection} agent={data.agent} fromAgent={params.get("from") === "agent"} />
      ) : data ? (
        <ChannelEditor
          key={`${connectionId ?? "new"}:${data.agent.id}:${channel}`}
          data={data}
          channel={(data.connection?.channel ?? channel) as SupportedChannel}
          fromAgent={params.get("from") === "agent"}
        />
      ) : (
        <BuildEmpty
          title="Channel unavailable"
          description="Return to Channels and choose an agent."
          action={
            <Button asChild variant="outline">
              <Link href={workspaceHref("/build/integrations")}>Channels</Link>
            </Button>
          }
        />
      )}
    </BuildState>
  )
}

function ChannelEditor({
  data,
  channel,
  fromAgent,
}: {
  data: EditorData
  channel: SupportedChannel
  fromAgent: boolean
}) {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const formId = React.useId()
  const mutation = useMutation()
  const [saved, setSaved] = React.useState(data.connection)
  const [label, setLabel] = React.useState(data.connection?.label ?? "")
  const [origins, setOrigins] = React.useState(
    originsOf(data.connection).join("\n")
  )
  const [mode, setMode] = React.useState<"webhook" | "polling">(
    modeOf(data.connection)
  )
  const [token, setToken] = React.useState("")
  const [tab, setTab] = React.useState("overview")
  const [notice, setNotice] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const createKey = React.useRef<{ payload: string; key: string } | null>(null)
  const agentHref = workspaceHref(
    `/build/agents/${encodeURIComponent(data.agent.id)}`
  )
  const backHref = fromAgent
    ? `${agentHref}?section=channels`
    : workspaceHref(
        `/build/integrations?agentId=${encodeURIComponent(data.agent.id)}`
      )
  const dirty =
    label !== (saved?.label ?? "") ||
    origins !== originsOf(saved).join("\n") ||
    mode !== modeOf(saved) ||
    Boolean(token)
  const needsConnection =
    channel === "telegram" &&
    saved !== null &&
    ["draft", "error", "disconnected"].includes(saved.status)
  React.useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", prevent)
    return () => window.removeEventListener("beforeunload", prevent)
  }, [dirty])

  async function reloadConnection(id: string) {
    const result = await buildApi.call<{ connection: ChannelConnection }>(
      "build_get_channel",
      { connectionId: id }
    )
    setSaved(result.connection)
    return result.connection
  }
  async function connect(id: string) {
    if (channel === "telegram") {
      try {
        await buildApi.call("build_register_telegram", {
          connectionId: id,
          mode,
          dropPendingUpdates: false,
        })
      } catch (error) {
        await reloadConnection(id).catch(() => undefined)
        throw error
      }
    } else {
      await buildApi.call("build_update_channel_status", {
        connectionId: id,
        status: "connected",
      })
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setNotice(null)
    let created: ChannelConnection | null = null
    try {
      await mutation.run(async () => {
        const originAllowlist = origins
          .split(/\r?\n|,/)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => {
            const url = new URL(value)
            if (
              !["https:", "http:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            )
              throw new Error(
                "Enter an origin such as https://example.com, without a path."
              )
            return url.origin
          })
        if (!saved) {
          const input = {
            agentId: data.agent.id,
            channel,
            label: label.trim(),
            config: channel === "web" ? { originAllowlist } : { mode },
            ...(channel === "telegram"
              ? { credentials: { token: token.trim() }, mode }
              : {}),
          }
          const payload = JSON.stringify(input)
          if (createKey.current?.payload !== payload)
            createKey.current = { payload, key: crypto.randomUUID() }
          created = await buildApi.call<ChannelConnection>(
            "build_create_channel",
            input,
            { idempotencyKey: createKey.current.key }
          )
          createKey.current = null
          setSaved(created)
          setToken("")
          await connect(created.id)
          await reloadConnection(created.id)
          setNotice("Channel connected.")
        } else {
          const updated = await buildApi.call<ChannelConnection>(
            "build_update_channel",
            {
              connectionId: saved.id,
              label: label.trim(),
              ...(channel === "web" ? { originAllowlist } : {}),
            }
          )
          setSaved(updated)
          if (
            channel === "telegram" &&
            (needsConnection || mode !== modeOf(saved))
          )
            await connect(saved.id)
          const current = await reloadConnection(saved.id)
          setLabel(current.label)
          setOrigins(originsOf(current).join("\n"))
          setMode(modeOf(current))
          setNotice("Changes saved.")
        }
      })
    } catch {
      // Keep entered settings and show the shared API error. A created connection
      // remains available even if registration needs a separate retry.
    } finally {
      if (created) {
        const query = new URLSearchParams({ agentId: data.agent.id })
        if (fromAgent) query.set("from", "agent")
        router.replace(
          workspaceHref(
            `/build/integrations/${(created as ChannelConnection).id}?${query}`
          )
        )
      }
    }
  }
  async function runAction(
    action: "connect" | "pause" | "resume" | "disconnect" | "poll"
  ) {
    if (!saved) return
    setNotice(null)
    try {
      await mutation.run(async () => {
        if (action === "connect") await connect(saved.id)
        else if (action === "poll")
          await buildApi.call("build_enqueue_telegram_polling", {})
        else if (action === "disconnect" && channel === "telegram")
          await buildApi.call("build_unregister_telegram", {
            connectionId: saved.id,
            dropPendingUpdates: false,
          })
        else
          await buildApi.call("build_update_channel_status", {
            connectionId: saved.id,
            status:
              action === "pause"
                ? "paused"
                : action === "disconnect"
                  ? "disconnected"
                  : "connected",
          })
        await reloadConnection(saved.id)
        setNotice(action === "poll" ? "Polling queued." : "Channel updated.")
      })
    } catch {
      /* The shared mutation error is shown in the sidebar. */
    }
  }
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const chatUrl = saved ? `${origin}/chat/${saved.id}` : ""
  const snippet = saved
    ? `<script src="${origin}/datool-widget.js" data-channel-id="${saved.id}" defer></script>`
    : ""
  const appearance = data.agent.configuration.appearance
  const goBack = (event: React.MouseEvent) => {
    if (dirty && !window.confirm("Discard unsaved channel changes?"))
      event.preventDefault()
  }

  return (
    <div
      role="region"
      aria-label="Channel editor"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {fromAgent ? (
        <AgentSidebarNavigation
          name={data.agent.name}
          active="channels"
          canConfigure
          agentHref={agentHref}
          onChange={(section) => {
            if (!dirty || window.confirm("Discard unsaved channel changes?"))
              router.push(`${agentHref}?section=${section}`)
          }}
        />
      ) : null}
      <HeaderSlot name="title">
        <div className="flex min-w-0 items-center gap-2">
          <ChannelIcon channel={channel} className="size-7" />
          <h1 className="truncate text-sm font-medium">
            {saved?.label || `Set up ${channelLabel(channel)}`}
          </h1>
        </div>
      </HeaderSlot>
      <div
        role="group"
        aria-label="Channel controls"
        className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"
      >
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref} onClick={goBack}>
            <ArrowLeft className="size-4" />
            Channels
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          {saved ? <BuildStatus status={saved.status} /> : null}
          {dirty ? (
            <span className="text-xs text-foreground-muted">
              Unsaved changes
            </span>
          ) : null}
          <Button
            type="submit"
            form={formId}
            size="sm"
            loading={mutation.isPending}
            disabled={saved ? !dirty && !needsConnection : false}
          >
            {needsConnection ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <Save className="size-3.5" />
            )}
            {needsConnection
              ? "Reconnect"
              : saved
                ? "Save changes"
                : "Connect channel"}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[22rem_minmax(0,1fr)] lg:overflow-hidden">
        <aside
          aria-label="Channel settings"
          className="min-w-0 border-b border-border bg-background lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <Tabs value={tab} onValueChange={setTab} className="p-5">
            <TabsList
              className="mb-6 grid grid-cols-3"
              aria-label="Channel settings sections"
            >
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="installation" disabled={!saved}>
                Installation
              </TabsTrigger>
              <TabsTrigger value="activity" disabled={!saved}>
                Activity
              </TabsTrigger>
            </TabsList>
            {mutation.error ? (
              <Notice role="alert" variant="error" className="mb-4">
                {mutation.error.message}
              </Notice>
            ) : null}
            {notice ? (
              <Notice role="status" variant="success" className="mb-4">
                {notice}
              </Notice>
            ) : null}
            {saved?.lastError && !mutation.error ? (
              <Notice variant="error" className="mb-4">
                {saved.lastError}
              </Notice>
            ) : null}
            <TabsContent
              value="overview"
              forceMount
              hidden={tab !== "overview"}
            >
              <form
                id={formId}
                onSubmit={(event) => void save(event)}
                aria-label="Channel configuration"
              >
                <fieldset
                  disabled={mutation.isPending}
                  className="min-w-0 space-y-5"
                >
                  <ChannelIdentity channel={channel} />
                  <FormLabel label="Connection name">
                    <Input
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                      required
                      maxLength={200}
                      placeholder={`${channelLabel(channel)} support`}
                    />
                  </FormLabel>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Agent</p>
                    <Link
                      href={`${agentHref}?section=instructions`}
                      onClick={goBack}
                      className="text-sm text-foreground-muted underline underline-offset-4"
                    >
                      {data.agent.name}
                    </Link>
                    <p className="text-xs leading-5 text-foreground-muted">
                      Uses this agent’s instructions, knowledge and guardrails.
                    </p>
                  </div>
                  {channel === "web" ? (
                    <FormLabel
                      label="Allowed origins"
                      hintPlacement="below"
                      hint="One website origin per line. Leave empty to allow any website."
                    >
                      <Textarea
                        rows={4}
                        value={origins}
                        onChange={(event) => setOrigins(event.target.value)}
                        placeholder="https://example.com"
                      />
                    </FormLabel>
                  ) : (
                    <>
                      {!saved ? (
                        <FormLabel
                          label="Bot token"
                          hintPlacement="below"
                          hint="Create a bot with @BotFather on Telegram, then paste its token here."
                        >
                          <Input
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            autoComplete="new-password"
                            required
                            placeholder="123456:ABC…"
                          />
                        </FormLabel>
                      ) : (
                        <p className="text-xs text-foreground-muted">
                          Bot credentials are configured. Your token is never
                          displayed.
                        </p>
                      )}
                      <FormLabel
                        label="Delivery mode"
                        hintPlacement="below"
                        hint="Use polling for local testing. Webhooks need a public HTTPS URL."
                      >
                        <Select
                          value={mode}
                          onChange={(event) =>
                            setMode(event.target.value as "webhook" | "polling")
                          }
                        >
                          <option value="webhook">Webhook</option>
                          <option value="polling">Polling worker</option>
                        </Select>
                      </FormLabel>
                    </>
                  )}
                </fieldset>
              </form>
            </TabsContent>
            <TabsContent value="installation" className="space-y-5">
              {saved && channel === "web" ? (
                <>
                  <div className="space-y-2">
                    <h2 className="text-sm font-medium">Chat bubble</h2>
                    <p className="text-xs leading-5 text-foreground-muted">
                      Paste this script before the closing body tag on your
                      website.
                    </p>
                    <Textarea
                      aria-label="Website embed code"
                      value={snippet}
                      readOnly
                      rows={6}
                      className="font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void mutation
                          .run(async () => {
                            await navigator.clipboard.writeText(snippet)
                            setCopied(true)
                          })
                          .catch(() => undefined)
                      }
                    >
                      {copied ? (
                        <Check className="size-4" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                      {copied ? "Copied" : "Copy embed code"}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-sm font-medium">Hosted chat</h2>
                    <p className="text-xs leading-5 text-foreground-muted">
                      Open your agent’s chat page. Its origin must be in your
                      allowed origins.
                    </p>
                    <Input
                      aria-label="Hosted chat URL"
                      value={chatUrl}
                      readOnly
                    />
                    <Button asChild size="sm" variant="outline">
                      <a href={chatUrl} target="_blank" rel="noreferrer">
                        Open chat
                        <ArrowUpRight className="size-4" />
                      </a>
                    </Button>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <h2 className="text-sm font-medium">Test your bot</h2>
                  <p className="text-sm text-foreground-muted">
                    Open Telegram and send your bot a message. Replies use the
                    agent’s applied version.
                  </p>
                  {typeof saved?.config.botUsername === "string" &&
                  /^[a-zA-Z0-9_]+$/.test(saved.config.botUsername) ? (
                    <Button asChild size="sm" variant="outline">
                      <a
                        href={`https://t.me/${saved.config.botUsername}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open bot
                        <ArrowUpRight className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              )}
            </TabsContent>
            <TabsContent value="activity" className="space-y-5">
              {saved ? (
                <>
                  <dl className="space-y-4 text-sm">
                    <div>
                      <dt className="text-foreground-muted">Status</dt>
                      <dd className="mt-1">
                        <BuildStatus status={saved.status} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-foreground-muted">Last inbound</dt>
                      <dd className="mt-1">
                        {formatWhen(saved.lastInboundAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-foreground-muted">Last outbound</dt>
                      <dd className="mt-1">
                        {formatWhen(saved.lastOutboundAt)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    {saved.status === "connected" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => void runAction("pause")}
                      >
                        <Pause className="size-4" />
                        Pause delivery
                      </Button>
                    ) : saved.status === "paused" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => void runAction("resume")}
                      >
                        <Play className="size-4" />
                        Resume delivery
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => void runAction("connect")}
                      >
                        <RefreshCw className="size-4" />
                        Reconnect
                      </Button>
                    )}
                    {channel === "telegram" && modeOf(saved) === "polling" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => void runAction("poll")}
                      >
                        <Wifi className="size-4" />
                        Poll now
                      </Button>
                    ) : null}
                    {saved.status !== "disconnected" ? (
                      <Button
                        size="sm"
                        variant="ghost-muted"
                        disabled={mutation.isPending}
                        onClick={() => void runAction("disconnect")}
                      >
                        <Unplug className="size-4" />
                        Disconnect
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={mutation.isPending}
                      onClick={() =>
                        void mutation
                          .run(() => reloadConnection(saved.id))
                          .catch(() => undefined)
                      }
                    >
                      <RefreshCw className="size-4" />
                      Refresh
                    </Button>
                  </div>
                </>
              ) : null}
            </TabsContent>
          </Tabs>
        </aside>
        <section
          aria-label="Channel preview"
          className="flex min-h-[32rem] min-w-0 flex-col items-center justify-center gap-6 bg-muted/40 p-6 lg:overflow-y-auto lg:p-10"
        >
          <p className="text-xs font-medium text-foreground-muted">
            {channelLabel(channel)} · Appearance preview
          </p>
          <div className="flex min-h-[26rem] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg">
            <div className="flex items-center gap-3 border-b border-border p-4">
              <ChannelIcon channel={channel} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {appearance.displayName || data.agent.name}
                </p>
                <p className="text-xs text-foreground-muted">
                  {channelLabel(channel)}
                </p>
              </div>
            </div>
            <div className="flex-1 space-y-4 p-4">
              <div className="w-fit max-w-full rounded-xl bg-muted p-3 text-sm">
                {appearance.welcomeMessage || "Hi! How can I help?"}
              </div>
              {appearance.suggestedReplies.length ? (
                <div className="flex flex-wrap gap-2">
                  {appearance.suggestedReplies.map((reply) => (
                    <span
                      key={reply}
                      className="rounded-lg border border-border px-3 py-2 text-xs text-foreground-muted"
                    >
                      {reply}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="m-4 flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-3 text-sm text-foreground-muted">
              <span className="truncate">{appearance.inputPlaceholder}</span>
              {channel === "web" ? (
                <MessageCircle className="size-4 shrink-0" />
              ) : (
                <Send className="size-4 shrink-0" />
              )}
            </div>
          </div>
          <p className="max-w-sm text-center text-xs leading-5 text-foreground-muted">
            Appearance comes from{" "}
            <Link
              href={`${agentHref}?section=appearance`}
              onClick={goBack}
              className="underline underline-offset-4"
            >
              {data.agent.name}’s settings
            </Link>
            . Test replies in{" "}
            <Link
              href={`${agentHref}?section=playground`}
              onClick={goBack}
              className="underline underline-offset-4"
            >
              Playground
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
