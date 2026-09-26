"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Plug, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CodeEditor } from "@/components/ui/code-editor"
import { FormRow } from "@/components/ui/form-row"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Notice } from "@/components/ui/notice"
import { LoadingState } from "@/components/ui/loading-state"
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "@/components/ui/resizable"
import { projectFetch } from "@/lib/workspace-routing"
import type {
  AppDefinition,
  AvailableApp,
} from "@/src/lib/playground/contracts"
import { connectionTypes } from "@/src/lib/playground/connections"
import { HeaderSlot } from "./collection-header"
import { useWorkspaceHref } from "./workspace-path"
import { useRemote } from "./hooks"

function draftFor(app?: AppDefinition) {
  const http = app?.connection?.type === "webhook" ? app.connection : undefined
  return {
    id: app?.id ?? "",
    name: app?.name ?? "",
    mode: app?.mode ?? "input",
    type: app ? (app.connection?.type ?? "bridge") : "webhook",
    url: http?.url ?? "",
    method: http?.method ?? "POST",
    body: http?.body ?? "input",
    timeout: String((http?.timeoutMs ?? 60000) / 1000),
    headers: "",
    inputSchema: JSON.stringify(
      app?.inputSchema ?? { type: "object", properties: {} },
      null,
      2
    ),
    outputSchema: JSON.stringify(app?.outputSchema ?? {}, null, 2),
  }
}

export function AppDetailPage({ appId }: { appId: string }) {
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      const response = await projectFetch("/api/apps/config", { signal })
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.error?.message ?? "Unable to load app.")
      const app = (result.data as AvailableApp[]).find(
        (app) => app.id === appId
      )
      if (!app) throw new Error("App not found.")
      return app
    },
    [appId]
  )
  const state = useRemote(load, [appId])
  if (state.error)
    return (
      <Notice variant="error" role="alert" className="m-4">
        <p>{state.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={state.refresh}
        >
          Retry
        </Button>
      </Notice>
    )
  if (!state.data) return <LoadingState label="Loading app" />
  return <AppEditor key={appId} app={state.data} />
}

export function AppEditor({ app }: { app?: AppDefinition }) {
  const router = useRouter()
  const href = useWorkspaceHref()
  const [saved, setSaved] = React.useState(app)
  const [draft, setDraft] = React.useState(() => draftFor(app))
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [horizontal, setHorizontal] = React.useState(true)
  const form = React.useRef<HTMLFormElement>(null)
  const saving = React.useRef(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFor(saved))
  const canSave = dirty && !!draft.id.trim() && !!draft.name.trim()
  const set = (field: keyof typeof draft, value: string) =>
    setDraft((previous) => ({ ...previous, [field]: value }))

  React.useEffect(() => {
    const element = form.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setHorizontal(entry.contentRect.width >= 800)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (!event.repeat && canSave && !pending) form.current?.requestSubmit()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [canSave, pending])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave || saving.current) return
    saving.current = true
    setPending(true)
    setError(null)
    try {
      const connection =
        draft.type === "bridge"
          ? { type: "bridge" }
          : {
              type: "webhook",
              url: draft.url,
              method: draft.method,
              body: draft.body,
              timeoutMs: Number(draft.timeout) * 1000,
              ...(draft.headers.trim()
                ? { headers: JSON.parse(draft.headers) }
                : {}),
            }
      const response = await projectFetch("/api/apps/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            id: draft.id,
            name: draft.name,
            mode: draft.mode,
            connection,
            inputSchema: JSON.parse(draft.inputSchema),
            outputSchema: JSON.parse(draft.outputSchema),
            evaluatorIds: saved?.evaluatorIds ?? [],
            internalTracing: saved?.internalTracing ?? false,
            ...(saved?.defaultInput === undefined
              ? {}
              : { defaultInput: saved.defaultInput }),
            expectedRevision: saved?.revision ?? 0,
          },
        ]),
      })
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.error?.message ?? "Unable to save app.")
      const next = (result.data as AppDefinition[])[0]
      setSaved(next)
      setDraft(draftFor(next))
      if (!saved) router.replace(href(`/apps/${encodeURIComponent(next.id)}`))
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save app.")
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  return (
    <form
      ref={form}
      onSubmit={save}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium">
          {saved?.name ?? "Create app"}
        </h1>
      </HeaderSlot>
      <div
        role="group"
        aria-label="App editor controls"
        className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2"
      >
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <Plug aria-hidden className="size-5 shrink-0" />
          <Input
            variant="title"
            className="-ml-2"
            aria-label="Name"
            placeholder="Untitled app"
            required
            maxLength={120}
            disabled={pending}
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
          />
          {dirty && (
            <span
              role="img"
              aria-label="Unsaved changes"
              className="size-2 shrink-0 rounded-full bg-warning"
            />
          )}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center gap-2">
          {saved && (
            <Button variant="outline" size="sm" asChild>
              <Link href={href(`/playground/${encodeURIComponent(saved.id)}`)}>
                Open playground
              </Link>
            </Button>
          )}
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Save"
            title="Save (⌘S)"
            aria-keyshortcuts="Meta+S Control+S"
            loading={pending}
            disabled={!canSave}
          >
            {!pending && <Save aria-hidden className="size-4" />}
          </Button>
        </div>
      </div>
      {error && (
        <Notice role="alert" variant="error" layout="banner">
          {error}
        </Notice>
      )}
      <ResizablePanelGroup
        key={horizontal ? "horizontal" : "vertical"}
        orientation={horizontal ? "horizontal" : "vertical"}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="app-configuration"
          defaultSize={horizontal ? "45%" : "55%"}
          minSize={horizontal ? "300px" : "25%"}
        >
          <section
            aria-label="App configuration"
            className="h-full overflow-y-auto px-4"
          >
            <fieldset disabled={pending} className="min-w-0">
              <FormRow label="App type" htmlFor="app-mode">
                <Select
                  id="app-mode"
                  value={draft.mode}
                  onChange={(event) => set("mode", event.target.value)}
                >
                  <option value="input">Workflow</option>
                  <option value="agent">Agent</option>
                </Select>
              </FormRow>
              <FormRow label="Connection type" htmlFor="app-connection">
                <Select
                  id="app-connection"
                  value={draft.type}
                  onChange={(event) => set("type", event.target.value)}
                >
                  {connectionTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </Select>
              </FormRow>
              <InspectorSection label="App ID" variant="form">
                <Input
                  aria-label="App ID"
                  required
                  maxLength={120}
                  disabled={!!saved}
                  pattern="[a-zA-Z0-9_.-]+"
                  placeholder="my-app"
                  value={draft.id}
                  onChange={(event) => set("id", event.target.value)}
                />
              </InspectorSection>
              {draft.type === "webhook" ? (
                <>
                  <InspectorSection label="URL" variant="form">
                    <Input
                      aria-label="URL"
                      required
                      type="url"
                      placeholder="https://example.com/run"
                      value={draft.url}
                      onChange={(event) => set("url", event.target.value)}
                    />
                  </InspectorSection>
                  <FormRow label="HTTP method" htmlFor="app-method">
                    <Select
                      id="app-method"
                      value={draft.method}
                      onChange={(event) => set("method", event.target.value)}
                    >
                      {["POST", "PUT", "PATCH"].map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </Select>
                  </FormRow>
                  <FormRow label="Request body" htmlFor="app-body">
                    <Select
                      id="app-body"
                      value={draft.body}
                      onChange={(event) => set("body", event.target.value)}
                    >
                      <option value="input">Input JSON</option>
                      <option value="envelope">Datool envelope</option>
                    </Select>
                  </FormRow>
                  <p className="px-3 py-3 text-xs text-foreground-muted">
                    Input JSON sends the full input object. The Datool envelope
                    wraps workflow input in an input field and sends the agent
                    messages payload directly.
                  </p>
                  <FormRow label="Timeout (seconds)" htmlFor="app-timeout">
                    <Input
                      id="app-timeout"
                      required
                      type="number"
                      min={1}
                      max={60}
                      value={draft.timeout}
                      onChange={(event) => set("timeout", event.target.value)}
                    />
                  </FormRow>
                  <InspectorSection label="Headers" variant="form">
                    <Textarea
                      aria-label="Headers (JSON)"
                      autoComplete="off"
                      spellCheck={false}
                      rows={3}
                      autoSize
                      placeholder={'{"Authorization":"Bearer …"}'}
                      value={draft.headers}
                      onChange={(event) => set("headers", event.target.value)}
                    />
                    <p className="mt-2 text-xs text-foreground-muted">
                      Header values are encrypted and never displayed again.
                      Leave blank to keep saved headers; enter {"{}"} to clear
                      them.
                      {saved?.connection?.type === "webhook" &&
                      saved.connection.headerNames.length > 0
                        ? ` Saved: ${saved.connection.headerNames.join(", ")}.`
                        : ""}
                    </p>
                  </InspectorSection>
                </>
              ) : (
                <InspectorSection label="Local bridge" variant="form">
                  <p className="text-sm text-foreground-muted">
                    Run <code>bunx datool connect</code> in your app project.
                    The CLI receives runs and sends results over an outbound
                    connection.
                  </p>
                </InspectorSection>
              )}
            </fieldset>
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize app panels" />
        <ResizablePanel
          id="app-schemas"
          defaultSize={horizontal ? "55%" : "45%"}
          minSize="25%"
        >
          <section
            aria-label="App schemas"
            className="h-full overflow-y-auto px-4"
          >
            <InspectorSection label="Input schema" variant="form">
              <CodeEditor
                label="Input schema (JSON)"
                language="json"
                value={draft.inputSchema}
                onChange={(value) => set("inputSchema", value)}
                readOnly={pending}
                autoSize
                showPrettify
              />
              <p className="mt-2 text-xs text-foreground-muted">
                Define an object schema for the inputs your app accepts.
              </p>
            </InspectorSection>
            <InspectorSection label="Output schema" variant="form">
              <CodeEditor
                label="Output schema (JSON)"
                language="json"
                value={draft.outputSchema}
                onChange={(value) => set("outputSchema", value)}
                readOnly={pending}
                autoSize
                showPrettify
              />
            </InspectorSection>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </form>
  )
}
