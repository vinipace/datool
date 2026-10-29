"use client"

import { useRef, useState, useEffect } from "react"
import {
  Check,
  LayoutTemplate,
  Maximize2,
  MessageCircle,
  Moon,
  PanelsTopLeft,
  RotateCcw,
  Sun,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Chat } from "@/components/ui/chat"
import { ChatRichContent } from "@/components/ui/chat-rich-content"
import {
  Select,
  SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { WidgetDefinition } from "@/src/lib/build/contracts"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { cn } from "@/lib/utils"
import { Notice } from "@/components/ui/notice"
import { validateWidgetPreview } from "@/src/lib/build/widget-preview-client"
import type { WidgetPreviewReport } from "@/src/lib/build/widget-validation"

const modes = [
  { value: "widget", label: "Widget", icon: PanelsTopLeft },
  { value: "bubble", label: "Chat bubble", icon: MessageCircle },
  { value: "center", label: "Center stage", icon: Maximize2 },
  { value: "page", label: "Agent page", icon: LayoutTemplate },
]

export function WidgetPreview({
  definition,
  selectedState,
  onStateChange,
  onCodeStatus,
}: {
  definition: WidgetDefinition | null
  selectedState: string
  onStateChange: (state: string) => void
  onCodeStatus?: (error: string | null) => void
}) {
  const [locale, setLocale] = useState("en")
  const [mode, setMode] = useState("widget")
  const [theme, setTheme] = useState("light")
  const [event, setEvent] = useState<{ label: string; input: unknown } | null>(
    null
  )
  const [reset, setReset] = useState(0)
  const surface = useRef<HTMLDivElement>(null)
  const [check, setCheck] = useState<{
    key: string
    report: WidgetPreviewReport
  } | null>(null)
  const [checking, setChecking] = useState(false)
  const activeCheck = useRef<AbortController | null>(null)
  const checkKey = JSON.stringify([definition, selectedState, theme, mode])
  useEffect(() => () => activeCheck.current?.abort(), [])
  const report = check?.key === checkKey ? check.report : null
  async function validatePreview() {
    if (!definition) return
    activeCheck.current?.abort()
    const controller = new AbortController()
    activeCheck.current = controller
    setChecking(true)
    try {
      const result = await validateWidgetPreview(definition, {
        state: selectedState,
        width: Math.max(
          240,
          Math.min(
            1440,
            Math.round(
              surface.current?.querySelector("iframe")?.getBoundingClientRect()
                .width || 360
            )
          )
        ),
        themeElement: surface.current ?? undefined,
        signal: controller.signal,
      })
      setCheck({ key: checkKey, report: result })
    } catch (error) {
      if (!controller.signal.aborted)
        setCheck({
          key: checkKey,
          report: {
            valid: false,
            rendered: false,
            schemaValidated: false,
            diagnostics: [
              {
                code: "preview_error",
                severity: "error",
                message: String(error),
              },
            ],
          },
        })
    } finally {
      if (activeCheck.current === controller) setChecking(false)
    }
  }
  const selectedMode = modes.find((item) => item.value === mode)!
  const states = Object.keys(definition?.states ?? {})
  const message: InspectorMessage = {
    id: "widget-preview",
    role: "assistant",
    content: mode === "widget" ? "" : "Here’s how I can help.",
    toolCalls: [],
    metadata: { widget: definition, widgetState: selectedState },
  }
  function interact(
    _: InspectorMessage,
    value: Record<string, unknown>,
    label: string
  ) {
    const name = definition?.functions.find(
      (fn) => fn.actionId === value.actionId
    )?.name
    setEvent({ label: name || label, input: value.input })
  }
  return (
    <section
      aria-label="Widget preview"
      className="flex h-full min-h-0 flex-col bg-muted"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <span className="text-xs font-medium">Live preview</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={!definition}
            loading={checking}
            onClick={() => void validatePreview()}
          >
            Check preview
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Reset preview"
            onClick={() => {
              setReset((value) => value + 1)
              setEvent(null)
            }}
          >
            <RotateCcw />
          </Button>
          <Button
            size="icon-sm"
            variant={theme === "light" ? "secondary" : "ghost"}
            aria-label="Light preview"
            aria-pressed={theme === "light"}
            onClick={() => setTheme("light")}
          >
            <Sun />
          </Button>
          <Button
            size="icon-sm"
            variant={theme === "dark" ? "secondary" : "ghost"}
            aria-label="Dark preview"
            aria-pressed={theme === "dark"}
            onClick={() => setTheme("dark")}
          >
            <Moon />
          </Button>
        </div>
      </div>
      <div
        ref={surface}
        className={cn(
          "datool-chat-surface flex min-h-0 flex-1 overflow-y-auto p-5 sm:p-8",
          mode === "center" && "items-center",
          mode === "bubble" && "items-end justify-end"
        )}
        data-theme={theme}
      >
        {!definition ? (
          <p
            role="status"
            className="m-auto max-w-xs text-center text-sm text-foreground-muted"
          >
            Fix the highlighted fields to update the preview.
          </p>
        ) : (
          <div
            key={`${reset}-${selectedState}-${mode}`}
            className={cn(
              "mx-auto w-full min-w-0",
              mode === "widget" || mode === "center"
                ? "max-w-lg"
                : mode === "bubble"
                  ? "m-0 h-[min(600px,100%)] max-w-sm overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
                  : "h-full max-w-2xl"
            )}
          >
            {mode === "widget" || mode === "center" ? (
              <ChatRichContent
                locale={locale}
                variant="standalone"
                message={message}
                onInteraction={interact}
                onCodeStatus={onCodeStatus}
              />
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium">
                  <MessageCircle className="size-4" />
                  {definition.name || "Your agent"}
                </div>
                <div className="min-h-0 flex-1 p-3">
                  <Chat
                    locale={locale}
                    messages={[message]}
                    text=""
                    onTextChange={() => {}}
                    running={false}
                    canSubmit={false}
                    composerDisabled
                    placeholder="Preview conversation"
                    onWidgetInteraction={interact}
                    onCodeStatus={onCodeStatus}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {report && (
        <Notice variant={report.valid ? "success" : "error"} role="status">
          {report.valid
            ? "Preview checks passed. Review its appearance before saving."
            : report.diagnostics.map((item) => item.message).join(" ")}
        </Notice>
      )}
      {event && (
        <div
          role="status"
          className="border-t border-border bg-background px-4 py-3 text-xs"
        >
          <p className="flex items-center gap-2 font-medium">
            <Check className="size-3.5 text-success" />
            {event.label}
          </p>
          <p className="mt-1 text-foreground-muted">
            Interaction captured for preview. No action was executed.
          </p>
          <pre className="mt-2 max-h-24 overflow-auto text-foreground-muted">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border bg-background p-3">
        <Select
          aria-label="Preview language"
          className="w-auto"
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
        >
          <option value="en">English</option>
          <option value="pt-BR">Português (Brasil)</option>
          <option value="es">Español</option>
        </Select>
        <SelectRoot
          value={mode}
          onValueChange={(value) => {
            if (value) {
              setMode(value)
              setEvent(null)
            }
          }}
        >
          <SelectTrigger
            aria-label="Preview layout"
            className="w-auto min-w-36"
          >
            <selectedMode.icon className="size-4" />
            <SelectValue>{selectedMode.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {modes.map((item) => (
              <SelectItem value={item.value} key={item.value}>
                <item.icon className="size-4" />
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        {states.length > 0 && (
          <SelectRoot
            value={selectedState}
            onValueChange={(value) => {
              if (value) {
                onStateChange(value)
                setEvent(null)
              }
            }}
          >
            <SelectTrigger
              aria-label="Preview state"
              className="w-auto min-w-32"
            >
              <SelectValue>
                {selectedState === "default" ? "Default state" : selectedState}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {states.map((name) => (
                <SelectItem key={name} value={name}>
                  {name === "default" ? "Default state" : name}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectRoot>
        )}
      </div>
    </section>
  )
}
