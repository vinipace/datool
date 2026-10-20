"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  Check,
  Copy,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { SettingsSection } from "@/components/ui/settings-section"
import { HelpPageControls } from "./help-page-controls"
import { ColorField } from "@/components/ui/color-field"
import {
  BubbleIconPicker,
  BubbleLocalization,
  BubblePositionPicker,
  BubbleRadiusPicker,
} from "./bubble-display-controls"
import { Switch } from "@/components/ui/switch"
import { Notice } from "@/components/ui/notice"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { AgentSidebarNavigation } from "@/components/build/shared/agent-sidebar"
import { ChannelIdentity } from "@/components/build/shared/channel-identity"
import {
  BuildStatus,
  FormLabel,
} from "@/components/build/operations/build-page"
import { buildApi } from "@/components/build/operations/build-api"
import { BubblePreview } from "@/components/build/chat/bubble-preview"
import {
  chatBubbleSettingsSchema,
  resolveChatBubbleSettings,
  type ChatBubbleSettings,
} from "@/src/lib/build/chat-bubble"
import { createChannelAutosave } from "@/src/lib/build/channel-autosave"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"

export function ChatBubbleEditor({
  connection,
  agent,
  fromAgent = false,
  embedded = false,
}: {
  connection: ChannelConnection
  agent: ManagedAgent
  fromAgent?: boolean
  embedded?: boolean
}) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const [store] = React.useState(() =>
    createChannelAutosave(
      {
        label: connection.label,
        origins: Array.isArray(connection.config.originAllowlist)
          ? connection.config.originAllowlist.join("\n")
          : "",
        bubble: resolveChatBubbleSettings(
          agent.configuration.appearance,
          connection.config.bubble
        ),
      },
      connection,
      async (draft) => {
        const originAllowlist = draft.origins
          .split(/\n|,/)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => {
            let url: URL
            try {
              url = new URL(value)
            } catch {
              throw new Error(
                "Enter a complete website origin, such as https://example.com."
              )
            }
            if (
              !["https:", "http:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            )
              throw new Error(
                "Allowed origins must not include a path, query or credentials."
              )
            return url.origin
          })
        const bubble = chatBubbleSettingsSchema.parse({
          ...draft.bubble,
          localization: {
            ...draft.bubble.localization,
            translations: Object.fromEntries(
              Object.entries(draft.bubble.localization.translations).map(
                ([language, content]) => [
                  language,
                  {
                    ...content,
                    suggestedReplies: content?.suggestedReplies
                      ?.map((reply) => reply.trim())
                      .filter(Boolean),
                  },
                ]
              )
            ),
          },
          suggestedReplies: draft.bubble.suggestedReplies
            .map((reply) => reply.trim())
            .filter(Boolean),
        })
        return buildApi.call<ChannelConnection>("build_update_channel", {
          connectionId: connection.id,
          label: draft.label.trim(),
          originAllowlist,
          bubble,
        })
      }
    )
  )
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  const { draft } = state
  const settings = draft.bubble
  const isHelpPage = settings.layout === "help_page"
  const channelName = isHelpPage ? "Help Page" : "Chat Bubble"
  const [deployOpen, setDeployOpen] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(true)
  const settingsId = React.useId()
  const agentHref = workspaceHref(
    `/build/agents/${encodeURIComponent(agent.id)}`
  )
  const backHref = fromAgent
    ? `${agentHref}?section=channels`
    : workspaceHref(
        `/build/integrations?agentId=${encodeURIComponent(agent.id)}`
      )
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const pageUrl = `${origin}/chat/${connection.id}`
  const snippet = `<script src="${origin}/datool-widget.js" data-channel-id="${connection.id}" defer></script>`
  function update<K extends keyof ChatBubbleSettings>(
    key: K,
    value: ChatBubbleSettings[K]
  ) {
    store.update({
      ...store.getSnapshot().draft,
      bubble: { ...store.getSnapshot().draft.bubble, [key]: value },
    })
  }
  React.useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (store.pending()) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      if (store.pending() && !store.getSnapshot().error)
        void store.flush().catch(() => {})
    }
  }, [store])
  async function navigate(href: string) {
    try {
      await store.flush()
      router.push(href)
    } catch {
      /* Keep the draft visible for retry. */
    }
  }
  async function setDelivery(status: "connected" | "paused") {
    setWorking(true)
    setError(null)
    try {
      await store.flush()
      await buildApi.call("build_update_channel_status", {
        connectionId: connection.id,
        status,
      })
      const saved = await buildApi.call<{ connection: ChannelConnection }>(
        "build_get_channel",
        { connectionId: connection.id }
      )
      store.setConnection(saved.connection)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update delivery."
      )
    } finally {
      setWorking(false)
    }
  }
  async function deploy() {
    setWorking(true)
    setError(null)
    try {
      await store.flush()
      setDeployOpen(true)
    } catch {
      /* Autosave shows the failure and keeps the user's edits. */
    } finally {
      setWorking(false)
    }
  }
  const saving = state.status === "saving"
  return (
    <div
      role="region"
      aria-label={`${channelName} editor`}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {fromAgent && !embedded ? (
        <AgentSidebarNavigation
          name={agent.name}
          active="channels"
          canConfigure
          agentHref={agentHref}
          agentId={agent.id}
          appearance={agent.configuration.appearance}
          onChange={(section) =>
            void navigate(`${agentHref}?section=${section}`)
          }
        />
      ) : null}
      {!embedded ? (
        <HeaderSlot name="title">
          <h1>
            <ChannelIdentity channel={isHelpPage ? "help_page" : "web"} />
          </h1>
        </HeaderSlot>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {!embedded ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigate(backHref)}
            >
              <ArrowLeft className="size-4" />
              Channels
            </Button>
          ) : null}
          <Button
            variant="ghost-muted"
            size="sm"
            aria-label={settingsOpen ? "Hide settings" : "Show settings"}
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
            Settings
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs text-foreground-muted"
          >
            {saving ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : state.error ? null : (
              <Check className="size-3.5" />
            )}
            {state.error
              ? "Not saved"
              : saving
                ? "Saving…"
                : "All changes saved"}
          </span>
          <Button size="sm" loading={working} onClick={() => void deploy()}>
            <Rocket className="size-4" />
            Deploy
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:overflow-hidden",
          settingsOpen && "lg:grid-cols-[20rem_minmax(0,1fr)]"
        )}
      >
        <aside
          id={settingsId}
          hidden={!settingsOpen}
          aria-label={`${channelName} settings`}
          className="min-w-0 [scrollbar-width:thin] border-b border-border bg-background lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <Tabs defaultValue="display">
            <div className="p-4">
              <TabsList
                className="grid grid-cols-2"
                aria-label={`${channelName} sections`}
              >
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="display">Display</TabsTrigger>
              </TabsList>
            </div>
            {state.error ? (
              <div className="px-4 pb-4">
                <Notice variant="error" role="alert">
                  {state.error.message}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void store.flush().catch(() => {})}
                  >
                    Retry save
                  </Button>
                </Notice>
              </div>
            ) : null}
            {error ? (
              <div className="px-4 pb-4">
                <Notice variant="error" role="alert">
                  {error}
                </Notice>
              </div>
            ) : null}
            <TabsContent value="overview" className="space-y-6 p-4">
              <FormLabel label="Connection name">
                <Input
                  value={draft.label}
                  maxLength={200}
                  onChange={(event) =>
                    store.update({ ...draft, label: event.target.value })
                  }
                />
              </FormLabel>
              <div className="space-y-2">
                <p className="text-sm font-medium">Agent</p>
                <p className="text-sm text-foreground-muted">{agent.name}</p>
                <p className="text-xs leading-5 text-foreground-muted">
                  Uses this agent’s instructions, knowledge, actions and
                  guardrails.
                </p>
              </div>
              <FormLabel
                label="Allowed origins"
                hintPlacement="below"
                hint="One website origin per line. Leave empty to allow any website."
              >
                <Textarea
                  value={draft.origins}
                  rows={4}
                  placeholder="https://example.com"
                  onChange={(event) =>
                    store.update({ ...draft, origins: event.target.value })
                  }
                />
              </FormLabel>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Visibility</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {isHelpPage
                      ? "Make your help page available to visitors."
                      : "Enable the bubble on websites where it is embedded."}
                  </p>
                </div>
                <Switch
                  aria-label={`${channelName} visibility`}
                  checked={state.connection.status === "connected"}
                  disabled={working}
                  onCheckedChange={(checked) =>
                    void setDelivery(checked ? "connected" : "paused")
                  }
                />
              </div>
              <BuildStatus status={state.connection.status} />
            </TabsContent>
            <TabsContent value="display">
              {isHelpPage ? (
                <HelpPageControls
                  settings={settings.helpPage}
                  onChange={(value) => update("helpPage", value)}
                />
              ) : null}
              <SettingsSection title="Content">
                <div className="space-y-5">
                  <FormLabel label="Display name">
                    <Input
                      value={settings.displayName}
                      maxLength={160}
                      onChange={(event) =>
                        update("displayName", event.target.value)
                      }
                    />
                  </FormLabel>
                  <FormLabel label="Avatar URL">
                    <Input
                      type="url"
                      value={settings.avatarUrl ?? ""}
                      placeholder="https://example.com/logo.png"
                      onChange={(event) =>
                        update("avatarUrl", event.target.value || null)
                      }
                    />
                  </FormLabel>
                  <FormLabel label="Welcome message">
                    <Textarea
                      value={settings.welcomeMessage}
                      rows={3}
                      maxLength={4000}
                      onChange={(event) =>
                        update("welcomeMessage", event.target.value)
                      }
                    />
                  </FormLabel>
                  <FormLabel label="Input placeholder">
                    <Input
                      value={settings.inputPlaceholder}
                      maxLength={300}
                      onChange={(event) =>
                        update("inputPlaceholder", event.target.value)
                      }
                    />
                  </FormLabel>
                  <FormLabel
                    label="Suggested replies"
                    hint="One per line."
                    hintPlacement="below"
                  >
                    <Textarea
                      value={settings.suggestedReplies.join("\n")}
                      rows={3}
                      onChange={(event) =>
                        update(
                          "suggestedReplies",
                          event.target.value.split("\n")
                        )
                      }
                    />
                  </FormLabel>
                </div>
              </SettingsSection>
              <SettingsSection title="Style">
                <div className="space-y-5">
                  <FormLabel label="Theme">
                    <Select
                      value={settings.theme}
                      onChange={(event) =>
                        update("theme", event.target.value as "light" | "dark")
                      }
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </Select>
                  </FormLabel>
                  <FormLabel label="Accent color">
                    <ColorField
                      label="Accent color"
                      value={settings.primaryColor}
                      onChange={(value) => update("primaryColor", value)}
                    />
                  </FormLabel>
                  {!isHelpPage ? (
                    <Toggle
                      label="Use accent color for header"
                      checked={settings.accentHeader}
                      onChange={(value) => update("accentHeader", value)}
                    />
                  ) : null}
                  <Toggle
                    label="Use accent color for send icon"
                    checked={settings.accentSend}
                    onChange={(value) => update("accentSend", value)}
                  />
                  <BubbleRadiusPicker
                    value={settings.radius}
                    onChange={(value) => update("radius", value)}
                  />
                </div>
              </SettingsSection>
              <SettingsSection title="Typography">
                <div className="grid grid-cols-2 gap-3">
                  <FormLabel label="Font family">
                    <Select
                      value={settings.fontFamily}
                      onChange={(event) =>
                        update(
                          "fontFamily",
                          event.target.value as ChatBubbleSettings["fontFamily"]
                        )
                      }
                    >
                      <option value="system">System</option>
                      <option value="inter">Inter</option>
                      <option value="serif">Serif</option>
                    </Select>
                  </FormLabel>
                  <FormLabel label="Font size">
                    <Select
                      value={settings.fontSize}
                      onChange={(event) =>
                        update(
                          "fontSize",
                          Number(event.target.value) as 14 | 16 | 18
                        )
                      }
                    >
                      <option value="14">14px</option>
                      <option value="16">16px</option>
                      <option value="18">18px</option>
                    </Select>
                  </FormLabel>
                </div>
              </SettingsSection>
              {!isHelpPage ? (
                <SettingsSection title="Floating bubble">
                  <div className="space-y-5">
                    <BubblePositionPicker
                      value={settings.position}
                      onChange={(value) => update("position", value)}
                    />
                    <BubbleIconPicker
                      settings={settings}
                      onChange={(value) => update("launcherIcon", value)}
                    />
                    {settings.launcherIcon === "custom" ? (
                      <FormLabel label="Bubble icon URL">
                        <Input
                          type="url"
                          value={settings.launcherIconUrl ?? ""}
                          placeholder="https://example.com/icon.png"
                          onChange={(event) =>
                            update(
                              "launcherIconUrl",
                              event.target.value || null
                            )
                          }
                        />
                      </FormLabel>
                    ) : null}
                    <FormLabel label="Bubble button color">
                      <ColorField
                        label="Bubble button color"
                        value={settings.launcherColor ?? settings.primaryColor}
                        onChange={(value) => update("launcherColor", value)}
                        onReset={() => update("launcherColor", null)}
                      />
                    </FormLabel>

                    <FormLabel
                      label="Launcher label"
                      hint="Leave empty for an icon-only bubble."
                      hintPlacement="below"
                    >
                      <Input
                        value={settings.launcherLabel}
                        maxLength={40}
                        onChange={(event) =>
                          update("launcherLabel", event.target.value)
                        }
                      />
                    </FormLabel>
                    <div className="grid grid-cols-2 gap-3">
                      <FormLabel label="Side spacing (px)">
                        <Input
                          type="number"
                          min={0}
                          max={120}
                          value={settings.offsetX}
                          onChange={(event) =>
                            update("offsetX", Number(event.target.value))
                          }
                        />
                      </FormLabel>
                      <FormLabel label="Bottom spacing (px)">
                        <Input
                          type="number"
                          min={0}
                          max={120}
                          value={settings.offsetY}
                          onChange={(event) =>
                            update("offsetY", Number(event.target.value))
                          }
                        />
                      </FormLabel>
                    </div>
                  </div>
                </SettingsSection>
              ) : null}
              <SettingsSection title="Localization">
                <BubbleLocalization
                  settings={settings}
                  onChange={(value) => update("localization", value)}
                />
              </SettingsSection>
              <SettingsSection title="Capabilities">
                <div className="space-y-5">
                  <Toggle
                    label="Collect feedback"
                    checked={settings.showFeedback}
                    onChange={(value) => update("showFeedback", value)}
                  />
                  <Toggle
                    label="Show Powered by Datool"
                    checked={settings.showBranding}
                    onChange={(value) => update("showBranding", value)}
                  />
                </div>
              </SettingsSection>
            </TabsContent>
          </Tabs>
        </aside>
        <BubblePreview
          settings={settings}
          agentId={agent.id}
          channelId={connection.id}
          onBeforeSend={store.flush}
        />
      </div>
      <Dialog open={deployOpen} onOpenChange={setDeployOpen}>
        <DialogContent variant="side-sheet" className="sm:max-w-xl">
          <DialogHeader className="border-b border-border p-6">
            <DialogTitle>Deploy {channelName}</DialogTitle>
            <DialogDescription>
              {isHelpPage
                ? "Share your help page with a link. Your saved settings are loaded automatically."
                : "Add this script to your website. Your saved settings are loaded automatically."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{channelName} visibility</p>
                <p className="mt-1 text-sm text-foreground-muted">
                  {state.connection.status === "connected"
                    ? "Ready to receive visitors."
                    : `Enable the ${isHelpPage ? "page" : "bubble"} when you’re ready for visitors.`}
                </p>
              </div>
              <Switch
                aria-label={`Enable ${isHelpPage ? "help page" : "chat bubble"}`}
                checked={state.connection.status === "connected"}
                disabled={working}
                onCheckedChange={(checked) =>
                  void setDelivery(checked ? "connected" : "paused")
                }
              />
            </div>
            {error ? (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            ) : null}
            <div className="space-y-3">
              <h3 className="text-sm font-medium">
                {isHelpPage ? "Your help page URL" : "Embed on your website"}
              </h3>
              <p className="text-sm text-foreground-muted">
                {isHelpPage
                  ? "Share this link with customers or add it to your website’s navigation."
                  : "Paste this code before the closing </body> tag on each page where the bubble should appear."}
              </p>
              {isHelpPage ? (
                <Input aria-label="Help Page URL" readOnly value={pageUrl} />
              ) : (
                <Textarea
                  aria-label="Chat Bubble embed code"
                  readOnly
                  rows={5}
                  value={snippet}
                  className="font-mono text-xs"
                />
              )}
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      isHelpPage ? pageUrl : snippet
                    )
                    setCopied(true)
                  } catch {
                    setError("Copy failed. Select and copy the value above.")
                  }
                }}
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied
                  ? "Copied"
                  : isHelpPage
                    ? "Copy page URL"
                    : "Copy embed code"}
              </Button>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Allowed websites</h3>
              <p className="text-sm break-words whitespace-pre-line text-foreground-muted">
                {draft.origins.trim() ||
                  "All websites. Limit access in Overview → Allowed origins."}
              </p>
            </div>
            <Button asChild variant="outline">
              <Link
                target="_blank"
                rel="noreferrer"
                href={`/chat/${connection.id}`}
              >
                {isHelpPage ? "Open Help Page" : "Open chat preview"}
              </Link>
            </Button>
            <p className="text-xs leading-5 text-foreground-muted">
              {isHelpPage
                ? "This link uses your Datool server’s address. Localhost links work only on your computer; use a publicly reachable server to share with visitors."
                : "The embed uses this Datool server’s address. A website must be able to reach it over HTTPS outside local development."}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}
