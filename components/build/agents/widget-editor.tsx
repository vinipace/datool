"use client"

import { WidgetTranslationsEditor } from "./widget-translations-editor"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Eye,
  Layers,
  Languages,
  MoreHorizontal,
  PanelsTopLeft,
  Plus,
  Save,
  Settings2,
  Trash2,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Label } from "@/components/ui/label"
import { Notice } from "@/components/ui/notice"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  widgetDefinitionSchema,
  type WidgetComponent,
  type WidgetDefinition,
  type WidgetRecord,
} from "@/src/lib/build/contracts"
import type { JsonObject } from "@/src/lib/tracer/contracts"
import {
  buildCall,
  buildOperations,
  formatBuildError,
} from "../shared/build-api"
import { useWideViewport } from "../operations/use-wide-viewport"
import { WidgetFunctions } from "./widget-functions"
import { WidgetPreview } from "./widget-preview"
import {
  widgetAsCode,
  widgetComponentCode,
  widgetCodeDeclarations,
} from "@/src/lib/build/widget-code"

const starter: WidgetDefinition = {
  name: "Untitled widget",
  description: "",
  enabled: true,
  components: [
    {
      type: "card",
      title: "{{title}}",
      body: "{{description}}",
      actionId: null,
    },
  ],
  states: {
    default: {
      title: "Hello world",
      description: "How can we help you today?",
    },
  },
  code: `export default function Widget({ data, t }) {
  return <Card title={t(data.title)} body={t(data.description)} />
}
`,
  translations: {
    "pt-BR": {
      "Hello world": "Olá, mundo",
      "How can we help you today?": "Como podemos ajudar você hoje?",
    },
    es: {
      "Hello world": "Hola, mundo",
      "How can we help you today?": "¿Cómo podemos ayudarte hoy?",
    },
  },
  functions: [],
}
const objectSchema = {
  type: "object",
  additionalProperties: true,
} as JsonObject
const stringify = (value: unknown) => JSON.stringify(value, null, 2)

export function WidgetEditor({
  agentId,
  widget,
  initial,
  onClose,
  onSaved,
}: {
  agentId: string
  widget?: WidgetRecord
  initial?: WidgetDefinition
  onClose: () => void
  onSaved: (deleted?: boolean) => void
}) {
  const [record, setRecord] = useState(widget)
  const [draft, setDraft] = useState(() =>
    widgetAsCode(widget?.definition ?? initial ?? starter)
  )
  const [code, setCode] = useState(
    () => widgetAsCode(widget?.definition ?? initial ?? starter).code!
  )
  const [stateSources, setStateSources] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries({
        default: {},
        ...(widget?.definition ?? initial ?? starter).states,
      }).map(([key, value]) => [key, stringify(value)])
    )
  )
  const [baseline, setBaseline] = useState(() =>
    stringify({ draft, code, stateSources })
  )
  const [newId] = useState(() => crypto.randomUUID())
  const [tab, setTab] = useState("code")
  const [mobileView, setMobileView] = useState("editor")
  const [stateName, setStateName] = useState("default")
  const [newState, setNewState] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [codeValidation, setCodeValidation] = useState<{
    key: string
    error: string | null
  } | null>(null)
  const [insertRequest, setInsertRequest] = useState<{
    id: string
    text: string
  }>()
  const wide = useWideViewport(900)
  const dirty = stringify({ draft, code, stateSources }) !== baseline
  const validation = useMemo(() => {
    let location = "State data"
    try {
      const states: Record<string, unknown> = {}
      for (const [name, source] of Object.entries(stateSources)) {
        location = `State “${name}”`
        Object.defineProperty(states, name, {
          value: JSON.parse(source),
          enumerable: true,
        })
      }
      const result = widgetDefinitionSchema.safeParse({
        ...draft,
        name: draft.name.trim(),
        code,
        components: [],
        states,
      })
      if (!result.success)
        return {
          definition: null,
          error: result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join(" · "),
        }
      const names = result.data.functions.map((fn) => fn.name.trim())
      if (new Set(names).size !== names.length)
        return { definition: null, error: "Each function needs a unique name." }
      return { definition: result.data, error: null }
    } catch {
      return { definition: null, error: `${location} must contain valid JSON.` }
    }
  }, [draft, code, stateSources])
  const validationKey = stringify({
    code,
    schemaCode: draft.schemaCode,
    data: {
      ...validation.definition?.states.default,
      ...validation.definition?.states[stateName],
    },
  })
  const codeChecked = codeValidation?.key === validationKey
  const codeError = codeChecked ? codeValidation.error : null

  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", prevent)
    return () => window.removeEventListener("beforeunload", prevent)
  }, [dirty])
  function close() {
    if (pending) return
    if (dirty && !window.confirm("Discard your unsaved widget changes?")) return
    onClose()
  }
  async function save() {
    if (!validation.definition || !codeChecked || codeError || pending) return
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const next = await buildCall<WidgetRecord>(buildOperations.updateWidget, {
        agentId,
        id: record?.id ?? newId,
        ...(record
          ? { slug: record.slug, expectedRevision: record.revision }
          : {}),
        definition: validation.definition,
      })
      setRecord(next)
      setBaseline(stringify({ draft, code, stateSources }))
      setSaved(true)
      onSaved()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  async function remove() {
    if (!record || !window.confirm(`Delete “${record.definition.name}”?`))
      return
    setPending(true)
    setError(null)
    try {
      await buildCall(buildOperations.deleteWidget, {
        agentId,
        widgetId: record.id,
        expectedRevision: record.revision,
      })
      onSaved(true)
      onClose()
    } catch (reason) {
      setError(formatBuildError(reason))
      setPending(false)
    }
  }
  function insert(component: WidgetComponent) {
    const functions = draft.functions.map((fn) => ({ ...fn }))
    const snippet = widgetComponentCode(component, functions)
    setDraft((current) => ({ ...current, functions }))
    setInsertRequest({ id: crypto.randomUUID(), text: snippet })
    setTab("code")
    setMobileView("editor")
  }
  function addState() {
    const name = newState.trim()
    if (!name || Object.hasOwn(stateSources, name) || name.length > 120) return
    setStateSources((current) => ({
      ...current,
      [name]: current[stateName] ?? "{}",
    }))
    setStateName(name)
    setNewState("")
  }
  const stateEditor = (
    <CodeEditor
      key={stateName}
      label={`Data for ${stateName} state`}
      language="json"
      schema={objectSchema}
      value={stateSources[stateName] ?? "{}"}
      onChange={(value) =>
        setStateSources((current) => ({ ...current, [stateName]: value }))
      }
      variant="embedded"
      showPrettify
      className="h-full min-h-0"
      readOnly={pending}
    />
  )
  const editor = (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 flex-col"
    >
      <TabsList
        variant="underline"
        className="h-[49px] overflow-x-auto overflow-y-hidden border-b border-border px-5"
      >
        <TabsTrigger value="code">
          <Code2 className="size-4" />
          Code
        </TabsTrigger>
        <TabsTrigger value="functions">
          <Zap className="size-4" />
          Functions{draft.functions.length ? ` ${draft.functions.length}` : ""}
        </TabsTrigger>
        <TabsTrigger value="states">
          <Layers className="size-4" />
          States
        </TabsTrigger>
        <TabsTrigger value="translations">
          <Languages className="size-4" />
          Translations
        </TabsTrigger>
        <TabsTrigger value="settings">
          <Settings2 className="size-4" />
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="code"
        forceMount
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize="62%" minSize="25%" overflow="hidden">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
                <span className="flex items-center gap-2 text-xs text-foreground-muted">
                  <Code2 className="size-3.5" />
                  widget.jsx
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" disabled={pending}>
                      <Plus />
                      Component
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        insert({ type: "text", text: "Your message" })
                      }
                    >
                      Text
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        insert({
                          type: "card",
                          title: "Card title",
                          body: "Supporting details",
                          actionId: null,
                        })
                      }
                    >
                      Card
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        insert({
                          type: "list",
                          itemsPath: "items",
                          itemTemplate: "{{title}}",
                        })
                      }
                    >
                      List
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setTab("functions")}>
                      Button or form → connect a function
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CodeEditor
                label="Widget code"
                value={code}
                onChange={setCode}
                language="jsx"
                declarations={widgetCodeDeclarations}
                insertRequest={insertRequest}
                onInsertHandled={() => setInsertRequest(undefined)}
                className="min-h-0 flex-1"
                variant="embedded"
                showPrettify
                readOnly={pending}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="38%" minSize="20%" overflow="hidden">
            <Tabs
              defaultValue="schema"
              className="flex h-full min-h-0 flex-col"
            >
              <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pr-2">
                <TabsList variant="panel" className="min-w-0">
                  <TabsTrigger value="schema">Schema</TabsTrigger>
                  <TabsTrigger value="data">
                    {stateName === "default" ? "Default data" : stateName}
                  </TabsTrigger>
                </TabsList>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Manage states"
                  onClick={() => setTab("states")}
                >
                  <Layers />
                </Button>
              </div>
              <TabsContent value="schema" className="min-h-0 flex-1">
                <CodeEditor
                  label="Widget Zod schema"
                  language="javascript"
                  value={draft.schemaCode ?? ""}
                  onChange={(schemaCode) =>
                    setDraft((current) => ({ ...current, schemaCode }))
                  }
                  variant="embedded"
                  showPrettify
                  className="h-full"
                  readOnly={pending}
                />
              </TabsContent>
              <TabsContent value="data" className="min-h-0 flex-1">
                {stateEditor}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
        <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-foreground-muted">
          Define data with Zod in Schema, then use {"{data.title}"} in JSX.
          Connect named actions in Functions.
        </p>
      </TabsContent>
      <TabsContent
        value="translations"
        className="min-h-0 flex-1 overflow-auto p-5"
      >
        <fieldset disabled={pending} className="mx-auto min-w-0 max-w-4xl space-y-5">
          <WidgetTranslationsEditor
            translations={draft.translations}
            textKeys={[draft.name]}
            onChange={(translations) =>
              setDraft((current) => ({ ...current, translations }))
            }
          />
          <InspectorSection label="Using translations in code" defaultOpen={false} icon={<Code2 className="size-4" />}>
            <div className="space-y-2 text-xs text-foreground-muted">
              <p>Use the original text as the key. The chat selects the visitor’s language.</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-foreground"><code>{'export default function Widget({ t }) {\n  return <Text>{t("Request demo")}</Text>\n}'}</code></pre>
              <p>Form labels and options translate automatically. For a custom submit button, pass <code>{'submitLabel={t("Request demo")}'}</code>.</p>
            </div>
          </InspectorSection>
        </fieldset>
      </TabsContent>
      <TabsContent value="functions" className="min-h-0 flex-1">
        <fieldset disabled={pending} className="h-full min-w-0">
          <WidgetFunctions
            agentId={agentId}
            functions={draft.functions}
            onChange={(functions) =>
              setDraft((current) => ({ ...current, functions }))
            }
            onInsert={(fn, kind) =>
              insert(
                kind === "form"
                  ? {
                      type: "form",
                      submitActionId: fn.actionId!,
                      fields:
                        fn.inputSchema.properties &&
                        typeof fn.inputSchema.properties === "object" &&
                        !Array.isArray(fn.inputSchema.properties)
                          ? Object.keys(fn.inputSchema.properties).slice(0, 100)
                          : ["message"],
                    }
                  : { type: "button", label: fn.name, actionId: fn.actionId! }
              )
            }
          />
        </fieldset>
      </TabsContent>
      <TabsContent
        value="states"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <div className="space-y-4 border-b border-border p-5">
          <div>
            <h2 className="text-sm font-medium">Data states</h2>
            <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
              Default data is used in customer conversations. Add named states
              to preview different content. Action inputs override default
              values.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="New state name"
              placeholder="State name, e.g. order shipped"
              maxLength={120}
              value={newState}
              disabled={pending}
              onChange={(e) => setNewState(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addState()
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={
                pending ||
                !newState.trim() ||
                Object.hasOwn(stateSources, newState.trim())
              }
              onClick={addState}
            >
              <Plus />
              Add state
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.keys(stateSources).map((name) => (
              <Button
                key={name}
                size="sm"
                variant={name === stateName ? "secondary" : "ghost"}
                onClick={() => setStateName(name)}
              >
                <Layers className="size-3.5" />
                {name}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-xs font-medium">{stateName}</span>
          {stateName !== "default" && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={`Delete state ${stateName}`}
              onClick={() => {
                setStateSources((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([name]) => name !== stateName
                    )
                  )
                )
                setStateName("default")
              }}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1">{stateEditor}</div>
      </TabsContent>
      <TabsContent value="settings" className="flex-1 overflow-y-auto p-5">
        <fieldset disabled={pending} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="widget-description">Description</Label>
            <Textarea
              id="widget-description"
              placeholder="What does this widget help customers do?"
              value={draft.description}
              rows={4}
              maxLength={2000}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
            <div className="space-y-1">
              <Label htmlFor="widget-enabled">Enable widget</Label>
              <p className="text-xs text-foreground-muted">
                Allow this widget to be used after applying the agent’s changes.
              </p>
            </div>
            <Switch
              id="widget-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))
              }
            />
          </div>
        </fieldset>
      </TabsContent>
    </Tabs>
  )
  const preview = (
    <WidgetPreview
      definition={validation.definition}
      selectedState={stateName}
      onStateChange={setStateName}
      onCodeStatus={(error) => setCodeValidation({ key: validationKey, error })}
    />
  )

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent
        className="sm:max-w-none"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <SheetTitle className="sr-only">
          {record ? "Edit widget" : "Create widget"}
        </SheetTitle>
        <SheetDescription className="sr-only">
          Edit widget components, connect functions and preview data states.
        </SheetDescription>
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-4">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Back to widgets"
            onClick={close}
            disabled={pending}
          >
            <ArrowLeft />
          </Button>
          <PanelsTopLeft className="hidden size-4 shrink-0 text-action-widget sm:block" />
          <Input
            aria-label="Widget name"
            variant="title"
            value={draft.name}
            maxLength={160}
            className="min-w-0 flex-1 text-base sm:text-xl"
            disabled={pending}
            onChange={(e) =>
              setDraft((current) => ({ ...current, name: e.target.value }))
            }
          />
          <span className="hidden shrink-0 text-xs text-foreground-muted sm:inline-flex">
            {dirty ? (
              "Unsaved changes"
            ) : saved ? (
              <span className="flex items-center gap-1">
                <Check className="size-3.5 text-success" />
                Saved
              </span>
            ) : record ? (
              `Version ${record.revision}`
            ) : (
              "New widget"
            )}
          </span>
          <Button
            size="sm"
            aria-label={record ? "Save changes" : "Create widget"}
            loading={pending}
            disabled={
              !validation.definition ||
              !codeChecked ||
              Boolean(codeError) ||
              (!!record && !dirty)
            }
            onClick={() => void save()}
          >
            <Save className="size-3.5" />
            <span className="hidden sm:inline">
              {record ? "Save changes" : "Create widget"}
            </span>
            <span className="sm:hidden">{record ? "Save" : "Create"}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Widget options"
                disabled={pending}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!validation.definition}
                onSelect={() => {
                  void navigator.clipboard
                    .writeText(stringify(validation.definition))
                    .catch(() =>
                      setError("Could not copy the widget. Try again.")
                    )
                }}
              >
                <Copy />
                Copy definition
              </DropdownMenuItem>
              {record && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void remove()}
                  >
                    <Trash2 />
                    Delete widget
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        {(error || validation.error || codeError) && (
          <Notice variant="error" layout="banner" role="alert">
            {error || validation.error || codeError}
          </Notice>
        )}
        {!wide && (
          <div className="flex shrink-0 gap-2 border-b border-border p-2">
            <Button
              size="sm"
              variant={mobileView === "editor" ? "secondary" : "ghost"}
              onClick={() => setMobileView("editor")}
            >
              <Code2 />
              Editor
            </Button>
            <Button
              size="sm"
              variant={mobileView === "preview" ? "secondary" : "ghost"}
              onClick={() => setMobileView("preview")}
            >
              <Eye />
              Preview
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {wide ? (
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize="52%" minSize="35%" overflow="hidden">
                {editor}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="48%" minSize="30%" overflow="hidden">
                {preview}
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <>
              <div className={mobileView === "editor" ? "h-full" : "hidden"}>
                {editor}
              </div>
              <div className={mobileView === "preview" ? "h-full" : "hidden"}>
                {preview}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
