"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  MessagesSquare,
  RotateCcw,
  ChevronDown,
  Upload,
  Trash2,
  Variable,
} from "lucide-react"
import { createPromptAutosave } from "@/src/lib/tracer/prompt-autosave"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Chat } from "@/components/ui/chat"
import { CodeEditor } from "@/components/ui/code-editor"
import { FormRow } from "@/components/ui/form-row"
import { MessagesForm } from "@/components/ui/messages-form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Notice } from "@/components/ui/notice"
import { InspectorSection } from "@/components/ui/inspector-section"
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "@/components/ui/resizable"
import {
  promptInputSchema,
  promptDraftSchema,
  promptConfigSchema,
  promptVariables,
  type ManagedPrompt,
  type PromptInput,
  type PromptMessage,
} from "@/src/lib/tracer/prompts"
import { HeaderSlot } from "./collection-header"
import { useWorkspaceHref } from "./workspace-path"
import { ProjectModelField } from "./project-model-field"
import { promptRequest } from "./prompt-request"
import { GATEWAY_PROVIDER, OPENAI_PROVIDER } from "@/src/lib/model-providers"

const metadataSchema = { type: "object" }

function Field({
  label,
  children,
}: React.PropsWithChildren<{ label: string }>) {
  return (
    <label className="grid min-w-0 gap-2 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function PromptEditor({ prompt }: { prompt?: ManagedPrompt }) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const [autosave] = React.useState(() =>
    createPromptAutosave({
      initial: prompt,
      save: async (input, previous) => {
        const result = await promptRequest<ManagedPrompt>(
          previous ? `/${previous.id}` : "",
          previous ? "PUT" : "POST",
          {
            ...input,
            ...(previous ? { expectedRevision: previous.revision } : {}),
          }
        )
        return result
      },
    })
  )
  const state = React.useSyncExternalStore(
    autosave.subscribe,
    autosave.getSnapshot,
    autosave.getSnapshot
  )
  const { saved, error: saveError } = state
  const [viewedVersion, setViewedVersion] =
    React.useState<ManagedPrompt | null>(null)
  const draft = viewedVersion
    ? promptDraftSchema.parse(viewedVersion)
    : state.draft
  const metadataText = viewedVersion
    ? JSON.stringify(viewedVersion.metadata, null, 2)
    : state.metadataText
  const [slugEdited, setSlugEdited] = React.useState(Boolean(prompt))
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [publishing, setPublishing] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [messages, setMessages] = React.useState<PromptMessage[]>([])
  const [text, setText] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const [variables, setVariables] = React.useState<Record<string, string>>({})
  const [showVariables, setShowVariables] = React.useState(false)
  const [horizontal, setHorizontal] = React.useState(true)
  const container = React.useRef<HTMLDivElement>(null)
  const abort = React.useRef<AbortController | null>(null)
  const saving = React.useRef(false)
  const variableNames = promptVariables(draft)
  let metadataValid = true
  let current = draft
  try {
    const parsed = promptDraftSchema.shape.metadata.safeParse(
      JSON.parse(metadataText)
    )
    if (!parsed.success) metadataValid = false
    else current = { ...draft, metadata: parsed.data }
  } catch {
    metadataValid = false
  }
  const dirty = autosave.pending()
  const readOnly = pending || running || Boolean(viewedVersion)
  const configValid = promptConfigSchema.safeParse(draft).success
  const missingVariables = variableNames.some(
    (name) => !Object.hasOwn(variables, name)
  )
  const canSubmit =
    Boolean(text.trim()) &&
    configValid &&
    !missingVariables &&
    !running &&
    !pending

  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setHorizontal(entry.contentRect.width >= 800)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const savedHref =
    !prompt && saved ? href(`/prompts/${encodeURIComponent(saved.id)}`) : null
  React.useEffect(() => {
    // Next syncs native history writes back into the router. Depend on the
    // destination string, not the href callback recreated on every render.
    if (savedHref && window.location.pathname !== savedHref)
      window.history.replaceState(null, "", savedHref)
  }, [savedHref])
  React.useEffect(() => () => abort.current?.abort(), [])
  React.useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (!event.repeat) void autosave.flush().catch(() => {})
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => {
      window.removeEventListener("keydown", shortcut)
      if (!autosave.getSnapshot().error) void autosave.flush().catch(() => {})
    }
  }, [autosave])

  function update(patch: Partial<PromptInput>) {
    autosave.update(patch)
    if (
      [
        "messages",
        "model",
        "temperature",
        "maxTokens",
        "template",
        "output",
      ].some((key) => key in patch)
    ) {
      setMessages([])
      setPreviewError(null)
    }
  }
  async function publish() {
    if (saving.current || viewedVersion || saveError || !metadataValid) return
    const parsed = promptInputSchema.safeParse(current)
    if (!parsed.success) return
    saving.current = true
    setError(null)
    setPublishing(true)
    setPending(true)
    try {
      await autosave.flush()
      const latest = autosave.getSnapshot().saved
      if (!latest || autosave.pending() || !latest.hasDraft) return
      const result = await promptRequest<ManagedPrompt>(
        `/${latest.id}/publish`,
        "POST",
        {
          expectedRevision: latest.revision,
        }
      )
      autosave.acceptPublished(result)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      saving.current = false
      setPublishing(false)
      setPending(false)
    }
  }
  async function viewVersion(selected: string) {
    if (pending || dirty || running || !saved) return
    setError(null)
    setMessages([])
    if (selected === "draft") {
      setViewedVersion(null)
      return
    }
    setPending(true)
    try {
      setViewedVersion(
        await promptRequest<ManagedPrompt>(`/${saved.id}?version=${selected}`)
      )
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setPending(false)
    }
  }
  async function preview(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit || abort.current) return
    const next: PromptMessage[] = [
      ...messages,
      { role: "user", content: text.trim() },
    ]
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setPreviewError(null)
    setMessages(next)
    setText("")
    try {
      const result = await promptRequest<PromptMessage>(
        "/test",
        "POST",
        { config: draft, variables, messages: next },
        controller.signal
      )
      setMessages([...next, result])
      setText("")
    } catch (error) {
      setMessages(messages)
      setText(text)
      if (!controller.signal.aborted) setPreviewError((error as Error).message)
    } finally {
      abort.current = null
      setRunning(false)
    }
  }

  return (
    <div
      ref={container}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <HeaderSlot name="title">
        <h1 className="max-w-[calc(100cqw-16rem)] truncate text-sm font-medium">
          {saved?.name ?? "Create prompt"}
        </h1>
      </HeaderSlot>
      {saved?.publishedVersion != null && (
        <HeaderSlot name="actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Prompt version"
                disabled={pending || running || dirty}
              >
                {viewedVersion ? `Version ${viewedVersion.version}` : "Draft"}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={viewedVersion ? String(viewedVersion.version) : "draft"}
                onValueChange={(value) => void viewVersion(value)}
              >
                <DropdownMenuRadioItem value="draft">
                  Current draft
                </DropdownMenuRadioItem>
                {Array.from(
                  { length: saved.publishedVersion },
                  (_, index) => saved.publishedVersion! - index
                ).map((version) => (
                  <DropdownMenuRadioItem key={version} value={String(version)}>
                    Version {version}
                    {version === saved.publishedVersion && (
                      <span className="ml-auto text-xs text-foreground-muted">
                        Published
                      </span>
                    )}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </HeaderSlot>
      )}
      <div
        role="group"
        aria-label="Prompt controls"
        className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2"
      >
        <MessagesSquare className="size-4 text-foreground-muted" />
        <Input
          autoFocus={!prompt}
          aria-label="Name"
          variant="title"
          className="-ml-2 min-w-32"
          disabled={pending || running}
          readOnly={Boolean(viewedVersion)}
          placeholder="Untitled prompt"
          maxLength={120}
          value={draft.name}
          onChange={(event) => {
            const name = event.target.value
            update({
              name,
              ...(!slugEdited && saved?.publishedVersion == null
                ? {
                    slug: name
                      .normalize("NFKD")
                      .replace(/[\u0300-\u036f]/g, "")
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-|-$/g, ""),
                  }
                : {}),
            })
          }}
        />
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {saved && (
            <>
              <Button
                type="button"
                variant={confirmDelete ? "destructive" : "ghost-muted"}
                size="icon-sm"
                aria-label={
                  confirmDelete ? "Confirm delete prompt" : "Delete prompt"
                }
                title={
                  confirmDelete ? "Confirm delete prompt" : "Delete prompt"
                }
                disabled={pending || running || dirty}
                onClick={async () => {
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    return
                  }
                  setPending(true)
                  setError(null)
                  try {
                    await promptRequest(`/${saved.id}`, "DELETE", {
                      expectedRevision: saved.revision,
                    })
                    router.replace(href("/prompts"))
                  } catch (error) {
                    setError((error as Error).message)
                    setPending(false)
                    setConfirmDelete(false)
                  }
                }}
              >
                <Trash2 className="size-4" />
              </Button>
              {confirmDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              )}
            </>
          )}
          {viewedVersion ? (
            <Button
              type="button"
              size="sm"
              disabled={pending || running}
              onClick={() => {
                autosave.restore({
                  ...promptDraftSchema.parse(viewedVersion),
                  slug: saved!.slug,
                })
                setViewedVersion(null)
                setMessages([])
              }}
            >
              <RotateCcw className="size-4" />
              Restore to draft
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              loading={publishing}
              disabled={
                pending ||
                running ||
                Boolean(saveError) ||
                (!dirty && !saved?.hasDraft) ||
                !metadataValid ||
                !promptInputSchema.safeParse(current).success
              }
              title={
                !configValid
                  ? "Complete the model and messages before publishing"
                  : "Publish the latest draft"
              }
              onClick={() => void publish()}
            >
              <Upload className="size-4" />
              Publish
            </Button>
          )}
        </div>
      </div>
      {(error || saveError) && (
        <Notice variant="error" role="alert" className="m-3">
          {error || saveError}
          {saveError && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void autosave.flush().catch(() => {})}
            >
              Retry autosave
            </Button>
          )}
        </Notice>
      )}
      <ResizablePanelGroup
        key={horizontal ? "horizontal" : "vertical"}
        orientation={horizontal ? "horizontal" : "vertical"}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="prompt-configuration"
          defaultSize={horizontal ? "36%" : "50%"}
          minSize={horizontal ? "300px" : "25%"}
        >
          <section
            aria-label="Prompt configuration"
            className="h-full overflow-y-auto px-4"
          >
            <fieldset disabled={readOnly} className="min-w-0">
              <ProjectModelField
                model={draft.model}
                provider={draft.provider}
                disabled={readOnly}
                onChange={(selection) => {
                  if (selection.provider === GATEWAY_PROVIDER || selection.provider === OPENAI_PROVIDER)
                    update({ ...selection, provider: selection.provider })
                }}
              />
              <MessagesForm<PromptMessage["role"]>
                messages={draft.messages}
                onChange={(messages) => update({ messages })}
                roles={[
                  { value: "system", label: "System" },
                  { value: "user", label: "User" },
                  { value: "assistant", label: "Assistant" },
                ]}
                defaultRole="user"
                maxMessages={50}
                disabled={readOnly}
                language={
                  draft.template === "mustache" ? "mustache" : "plaintext"
                }
                description={
                  draft.template === "mustache" ? (
                    <>Use {"{{variable}}"} for values supplied by your agent.</>
                  ) : undefined
                }
              />
              <FormRow label="Template format" htmlFor="prompt-template">
                <Select
                  id="prompt-template"
                  value={draft.template}
                  onChange={(event) =>
                    update({
                      template: event.target.value as PromptInput["template"],
                    })
                  }
                >
                  <option value="mustache">Mustache</option>
                  <option value="none">Plain text</option>
                </Select>
              </FormRow>
              <FormRow label="Output format" htmlFor="prompt-output">
                <Select
                  id="prompt-output"
                  value={draft.output}
                  onChange={(event) =>
                    update({
                      output: event.target.value as PromptInput["output"],
                    })
                  }
                >
                  <option value="text">Text output</option>
                  <option value="json">JSON output</option>
                </Select>
              </FormRow>
              <FormRow label="Temperature" htmlFor="prompt-temperature">
                <div className="flex min-w-0 items-center gap-3">
                  <Slider
                    aria-label="Temperature slider"
                    className="min-w-0 flex-1"
                    min={0}
                    max={2}
                    step={0.1}
                    value={[draft.temperature ?? 1]}
                    disabled={readOnly}
                    onValueChange={([temperature]) => update({ temperature })}
                  />
                  <Input
                    id="prompt-temperature"
                    className="w-24 shrink-0"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    placeholder="Default"
                    title="Leave empty to use the model default"
                    value={draft.temperature ?? ""}
                    onChange={(event) =>
                      update({
                        temperature:
                          event.target.value === ""
                            ? undefined
                            : Math.min(
                                2,
                                Math.max(0, Number(event.target.value))
                              ),
                      })
                    }
                  />
                </div>
              </FormRow>
              <FormRow label="Max output tokens" htmlFor="prompt-max-tokens">
                <Input
                  id="prompt-max-tokens"
                  type="number"
                  min={1}
                  max={128000}
                  placeholder="Model default"
                  value={draft.maxTokens ?? ""}
                  onChange={(event) =>
                    update({
                      maxTokens:
                        event.target.value === ""
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </FormRow>
              <InspectorSection label="Description" variant="form">
                <Textarea
                  aria-label="Description"
                  autoSize
                  rows={1}
                  className="mt-2"
                  placeholder="What does this prompt do?"
                  value={draft.description}
                  onChange={(event) =>
                    update({ description: event.target.value })
                  }
                />
              </InspectorSection>
              <InspectorSection label="Slug" variant="form">
                <Input
                  aria-label="Slug"
                  readOnly={saved?.publishedVersion != null}
                  title={
                    saved?.publishedVersion != null
                      ? "Published slugs stay fixed so agent lookups keep working"
                      : undefined
                  }
                  placeholder="Enter slug"
                  maxLength={120}
                  value={draft.slug}
                  onChange={(event) => {
                    setSlugEdited(true)
                    update({ slug: event.target.value })
                  }}
                />
              </InspectorSection>
              <InspectorSection label="Metadata" variant="form">
                <CodeEditor
                  label="Metadata"
                  language="json"
                  schema={metadataSchema}
                  autoSize
                  showPrettify
                  readOnly={readOnly}
                  value={metadataText}
                  onChange={autosave.updateMetadata}
                />
                {!metadataValid && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    Enter a valid JSON object.
                  </p>
                )}
              </InspectorSection>
            </fieldset>
          </section>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="prompt-preview"
          defaultSize={horizontal ? "64%" : "50%"}
          minSize="30%"
        >
          <form
            onSubmit={preview}
            aria-label="Test prompt"
            className="flex h-full min-h-0 flex-col px-4"
          >
            {previewError && (
              <Notice variant="error" role="alert" className="mt-3">
                {previewError}
              </Notice>
            )}
            <Chat
              messages={messages.map((message) => ({
                ...message,
                toolCalls: [],
              }))}
              text={text}
              onTextChange={setText}
              running={running}
              canSubmit={canSubmit}
              placeholder="Chat with your prompt…"
              composerToolbar={
                <div className="mb-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={showVariables}
                      onClick={() => setShowVariables((value) => !value)}
                    >
                      <Variable className="size-4" />
                      Variables
                      {variableNames.length ? ` (${variableNames.length})` : ""}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label="Clear conversation"
                      title="Clear conversation"
                      disabled={!messages.length || running}
                      onClick={() => {
                        setMessages([])
                        setPreviewError(null)
                      }}
                    >
                      <RotateCcw className="size-4" />
                    </Button>
                    {running && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => abort.current?.abort()}
                      >
                        Stop
                      </Button>
                    )}
                  </div>
                  {showVariables && (
                    <div className="max-h-48 space-y-3 overflow-y-auto rounded-lg border border-border p-3">
                      {variableNames.length ? (
                        variableNames.map((name) => (
                          <Field key={name} label={name}>
                            <Input
                              value={variables[name] ?? ""}
                              disabled={running}
                              placeholder={`Value for ${name}`}
                              onChange={(event) => {
                                setVariables((value) => ({
                                  ...value,
                                  [name]: event.target.value,
                                }))
                                setMessages([])
                              }}
                            />
                          </Field>
                        ))
                      ) : (
                        <p className="text-sm text-foreground-muted">
                          Add {"{{variable}}"} to a message to test it with
                          different values.
                        </p>
                      )}
                    </div>
                  )}
                  {missingVariables && (
                    <p className="text-xs text-foreground-muted">
                      Enter your variable values before sending a message.
                    </p>
                  )}
                </div>
              }
            />
          </form>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
