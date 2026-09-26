"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Play, Plus, Settings } from "lucide-react"
import { projectFetch } from "@/lib/workspace-routing"
import type { AvailableApp } from "@/src/lib/playground/contracts"
import { initialAppInput } from "@/src/lib/playground/input-form"
import {
  appendChatMessage,
  appendChatResponse,
  readChatInput,
} from "@/src/lib/playground/chat-input"
import { normaliseChatMessages } from "@/src/lib/tracer/value-messages"
import {
  changeInputFormat,
  inputDocument,
  parseInputDocument,
  type InputFormat,
} from "@/src/lib/playground/input-document"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { CodeEditor } from "@/components/ui/code-editor"
import { Chat } from "@/components/ui/chat"
import { Notice } from "@/components/ui/notice"
import { LoadingState } from "@/components/ui/loading-state"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage, CollectionSearch } from "./collection-page"
import { HeaderSlot } from "./collection-header"
import {
  LogTable,
  LogTableBody,
  LogRow,
  LogRowSelection,
  LogSelectAll,
} from "./log-table"
import { logTable } from "./log-table-styles"
import { SpanKindIcon } from "./span-kind-icon"
import { useRemote } from "./hooks"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"
import { useTableView } from "./use-table-view"
import { PlaygroundInputForm } from "./playground-input-form"
import { RunTraceInspector } from "./trace-inspector"
import { loadPlaygroundRun } from "./playground-run-data"
import { PlaygroundScorers } from "./playground-scorers"
import { PanelActionLabel } from "@/components/ui/panel-action-label"

type AppInvocation = Awaited<ReturnType<typeof loadPlaygroundRun>>["invocation"]

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await projectFetch(`/api/apps${path}`, options)
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.error?.message ?? "Unable to load app.")
  return result.data
}

function useApps() {
  const load = React.useCallback(
    (signal: AbortSignal) => request<AvailableApp[]>("/config", { signal }),
    []
  )
  return useRemote(load, [], { intervalMs: 5_000 })
}

export function PlaygroundPage() {
  const state = useApps()
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const scope = useWorkspaceStorageScope()
  const tableView = useTableView({
    settingsStorageKey: `datool:playground-apps:${scope}:settings`,
    orderStorageKey: "datool.playground-apps.columns",
  })
  const [search, setSearch] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const rows = (state.data ?? []).filter((app) =>
    `${app.name} ${app.id} ${app.mode === "agent" ? "agent" : "workflow"}`
      .toLowerCase()
      .includes(search.toLowerCase())
  )
  return (
    <CollectionPanel label="Playground">
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel="Loading registered apps"
        toolbar={
          tableView.storageError ? (
            <Notice variant="error">{tableView.storageError}</Notice>
          ) : undefined
        }
        header={{
          actions: <Button size="sm" asChild><Link href={workspaceHref("/apps/new")}><Plus className="size-4" /><PanelActionLabel>New app</PanelActionLabel></Link></Button>,
          exportRows: selected.size
            ? rows.filter((app) => selected.has(app.id))
            : rows,
          exportName: "apps",
          children: (
            <CollectionSearch
              label="Search apps"
              value={search}
              onChange={setSearch}
            />
          ),
        }}
      >
        <LogTable
          fillHeight
          enableCardView
          settings={tableView.settings}
          onSettingsChange={tableView.onSettingsChange}
          columnOrderStore={tableView.columnOrderStore}
          widths={[260, 230, 160, 160, 100]}
          columnIds={["name", "id", "type", "status", "revision"]}
          reorderable
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll
                  label="Select all apps"
                  disabled={!rows.length}
                  checked={
                    !!rows.length && rows.every((app) => selected.has(app.id))
                  }
                  partial={
                    rows.some((app) => selected.has(app.id)) &&
                    !rows.every((app) => selected.has(app.id))
                  }
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      const all = rows.every((app) => current.has(app.id))
                      for (const app of rows) {
                        if (all) next.delete(app.id)
                        else next.add(app.id)
                      }
                      return next
                    })
                  }
                />
              </th>
              {["Name", "App ID", "Type", "Status", "Version"].map((label) => (
                <th key={label} className={logTable.heading}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <tr>
                <td
                  colSpan={6}
                  className="p-8 text-center text-sm text-foreground-muted"
                >
                  {search ? (
                    "No matching apps."
                  ) : (
                    <div className="space-y-2">
                      <p>No registered apps yet.</p>
                      <p>Register an HTTP app or connect your local workflows and agents.</p>
                      <code>bunx datool connect</code>
                    </div>
                  )}
                </td>
              </tr>
            }
          >
            {(app, index) => (
              <LogRow
                key={app.id}
                checked={selected.has(app.id)}
                rowLabel={`Open ${app.name}`}
                onClick={() =>
                  router.push(
                    workspaceHref(`/playground/${encodeURIComponent(app.id)}`)
                  )
                }
              >
                <LogRowSelection
                  index={index}
                  label={`Select ${app.name}`}
                  checked={selected.has(app.id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(app.id)) next.delete(app.id)
                      else next.add(app.id)
                      return next
                    })
                  }
                />
                <td className={logTable.cell}>
                  <Link
                    className="flex items-center gap-2 font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={workspaceHref(
                      `/playground/${encodeURIComponent(app.id)}`
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <SpanKindIcon
                      kind={app.mode === "agent" ? "agent" : "workflow"}
                    />
                    {app.name}
                  </Link>
                </td>
                <td
                  className={`${logTable.cell} font-mono text-xs text-foreground-muted`}
                >
                  {app.id}
                </td>
                <td className={logTable.cell}>
                  {app.mode === "agent" ? "Agent" : "Workflow"}
                </td>
                <td className={logTable.cell}>
                  <AppStatus online={app.online} webhook={app.connection?.type === "webhook"} />
                </td>
                <td className={logTable.cell}>v{app.revision}</td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
    </CollectionPanel>
  )
}

function AppStatus({ online, webhook }: { online: boolean; webhook?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${online ? "text-success" : "text-foreground-muted"}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${online ? "bg-success" : "bg-foreground-subtle"}`}
      />
      {webhook ? "HTTP webhook" : online ? "Connected" : "Offline"}
    </span>
  )
}

export function PlaygroundAppPage({ appId }: { appId: string }) {
  const state = useApps()
  const app = state.data?.find((app) => app.id === appId)
  if (!state.data)
    return state.error ? (
      <Notice role="alert" variant="error">
        {state.error.message}{" "}
        <Button variant="outline" size="sm" onClick={state.refresh}>
          Retry
        </Button>
      </Notice>
    ) : (
      <AppEditorLoading />
    )
  if (!app)
    return (
      <Notice role="alert">
        This app is no longer registered.{" "}
        <Button variant="outline" size="sm" onClick={state.refresh}>
          Refresh
        </Button>
      </Notice>
    )
  return (
    <AppEditor
      key={`${app.id}:${app.revision}`}
      app={app}
      refreshError={state.error}
      onRefresh={state.refresh}
    />
  )
}

function AppEditorLoading() {
  return (
    <div
      role="status"
      aria-label="Loading app"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-2 lg:grid-rows-1">
        <div className="space-y-6 border-b border-border p-6 lg:border-r lg:border-b-0">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
        <LoadingState label="Loading app" />
      </div>
    </div>
  )
}

function AppEditor({
  app,
  refreshError,
  onRefresh,
}: {
  app: AvailableApp
  refreshError: Error | null
  onRefresh: () => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const workspaceHref = useWorkspaceHref()
  const searchParams = useSearchParams()
  const traceId = searchParams.get("run")
  const scorerQuery = searchParams.get("scorers")
  const scorerIds =
    scorerQuery === null
      ? app.evaluatorIds
      : scorerQuery
        ? scorerQuery.split(",")
        : []
  const [draft, setDraft] = React.useState(() =>
    inputDocument(initialAppInput(app.inputSchema, app.defaultInput), "form")
  )
  let input: unknown
  let inputError: string | null = null
  try {
    input = parseInputDocument(draft)
  } catch (error) {
    inputError = (error as Error).message
  }
  const inputEdited = React.useRef(false)
  const [chatText, setChatText] = React.useState("")
  const lastAgentRun = React.useRef<Pick<
    AppInvocation,
    "input" | "output" | "status"
  > | null>(null)
  const restoreRunInput = React.useCallback((invocation: AppInvocation) => {
    lastAgentRun.current = invocation
    if (inputEdited.current) return
    inputEdited.current = true
    setDraft((current) =>
      inputDocument(
        current.format === "chat" && invocation.status === "completed"
          ? appendChatResponse(invocation.input, invocation.output)
          : invocation.input,
        current.format
      )
    )
  }, [])
  const [pending, setPending] = React.useState(false)
  const [navigating, startNavigation] = React.useTransition()
  const running = pending || navigating
  const chatting = draft.format === "chat"
  let conversation: ReturnType<typeof readChatInput> | null = null
  let chatError: string | null = null
  if (chatting && !inputError) {
    try {
      conversation = readChatInput(input)
    } catch (error) {
      chatError = (error as Error).message
    }
  }
  const canRun =
    app.online &&
    !running &&
    !inputError &&
    !chatError &&
    (!chatting ||
      !!chatText.trim() ||
      conversation?.messages.at(-1)?.role === "user")
  const [error, setError] = React.useState<string | null>(null)
  const submitting = React.useRef(false)
  const container = React.useRef<HTMLDivElement>(null)
  const [horizontal, setHorizontal] = React.useState(true)
  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setHorizontal(entry.contentRect.width >= 896)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  async function run(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || !canRun) return
    const submittedInput = chatting ? appendChatMessage(input, chatText) : input
    submitting.current = true
    inputEdited.current = true
    setPending(true)
    setError(null)
    if (chatting) {
      setDraft(inputDocument(submittedInput, "chat"))
      setChatText("")
    }
    try {
      const result = await request<{
        traceId: string
        status: AppInvocation["status"]
        output?: unknown
        error?: string
      }>(
        `/${encodeURIComponent(app.id)}/runs?${new URLSearchParams({ scorers: scorerIds.join(",") })}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submittedInput),
        }
      )
      const params = new URLSearchParams(searchParams.toString())
      params.set("run", result.traceId)
      startNavigation(() =>
        router.replace(`${pathname}?${params}`, { scroll: false })
      )
      if (app.mode === "agent") {
        lastAgentRun.current = {
          input: submittedInput as AppInvocation["input"],
          output: result.output as AppInvocation["output"],
          status: result.status,
        }
        if (chatting && result.status === "completed")
          setDraft(
            inputDocument(
              appendChatResponse(submittedInput, result.output),
              "chat"
            )
          )
        else if (chatting && result.status === "errored")
          setError(
            result.error ?? "The agent could not reply. Send again to retry."
          )
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <div
      ref={container}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium">{app.name}</h1>
      </HeaderSlot>
      <div
        role="group"
        aria-label="App controls"
        className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-2"
      >
        <SpanKindIcon kind={app.mode === "agent" ? "agent" : "workflow"} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {app.name}
        </h2>
        <AppStatus online={app.online} webhook={app.connection?.type === "webhook"} />
        <Button variant="outline" size="sm" asChild><Link href={workspaceHref(`/apps/${encodeURIComponent(app.id)}`)}><Settings aria-hidden className="size-4" />Connection settings</Link></Button>
        <Button
          size="icon-lg"
          shape="circle"
          aria-label="Run"
          title="Run"
          type="submit"
          form="playground-input"
          loading={running}
          disabled={!canRun}
        >
          {!running && (
            <Play aria-hidden="true" className="size-5 fill-current" />
          )}
        </Button>
      </div>
      {!app.online && (
        <Notice role="alert" variant="warning-solid" layout="banner">
          Connection lost. Reconnect this app with <code>bunx datool connect</code>{" "}
          to run it.
        </Notice>
      )}
      <ResizablePanelGroup
        orientation={horizontal ? "horizontal" : "vertical"}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="app-input"
          className={chatting ? "flex flex-col" : undefined}
          defaultSize="50%"
          minSize="20%"
          overflow={chatting ? "hidden" : "auto"}
        >
          <PlaygroundScorers
            value={scorerIds}
            disabled={running}
            onChange={(ids) => {
              const params = new URLSearchParams(searchParams.toString())
              params.set("scorers", ids.join(","))
              router.replace(`${pathname}?${params}`, { scroll: false })
            }}
          />
          <form
            id="playground-input"
            aria-label="App input"
            className={
              chatting
                ? "flex min-h-0 min-w-0 flex-1 flex-col px-4"
                : "min-w-0 px-4 pb-6"
            }
            onSubmit={run}
          >
            {refreshError && (
              <Notice role="alert" variant="error">
                {refreshError.message}{" "}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRefresh}
                >
                  Retry
                </Button>
              </Notice>
            )}
            {error && (
              <Notice role="alert" variant="error">
                {error}
              </Notice>
            )}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-3 text-sm">
              <span>Input</span>
              <Select
                aria-label="Input format"
                variant="borderless"
                className="w-auto"
                value={draft.format}
                disabled={running}
                onChange={(event) => {
                  if (inputError) return
                  const format = event.target.value as InputFormat
                  const saved = lastAgentRun.current
                  // Reopening a recorded run in Chat resumes after its reply.
                  const resume =
                    format === "chat" &&
                    saved?.status === "completed" &&
                    JSON.stringify(saved.input) === JSON.stringify(input)
                  setDraft((current) =>
                    resume
                      ? inputDocument(
                          appendChatResponse(input, saved.output),
                          "chat"
                        )
                      : changeInputFormat(current, format)
                  )
                }}
              >
                <option value="form">Form</option>
                <option value="json">JSON</option>
                <option value="yaml">YAML</option>
                {app.mode === "agent" && <option value="chat">Chat</option>}
              </Select>
            </div>
            {(inputError || chatError) && (
              <Notice role="alert" variant="error">
                {inputError || chatError}
              </Notice>
            )}
            <fieldset
              disabled={running}
              className={chatting ? "min-h-0 min-w-0 flex-1" : "min-w-0"}
            >
              {draft.format === "form" ? (
                <PlaygroundInputForm
                  schema={app.inputSchema}
                  value={input}
                  onChange={(value) => {
                    inputEdited.current = true
                    setDraft({ format: "form", value })
                  }}
                />
              ) : draft.format === "chat" ? (
                <Chat
                  messages={normaliseChatMessages(conversation) ?? []}
                  text={chatText}
                  onTextChange={(text) => {
                    inputEdited.current = true
                    setChatText(text)
                  }}
                  running={running}
                  canSubmit={!!canRun}
                />
              ) : (
                <div className="py-4">
                  <CodeEditor
                    label={`${draft.format.toUpperCase()} input`}
                    language={draft.format}
                    value={draft.text}
                    readOnly={running}
                    showPrettify={draft.format === "json"}
                    className="h-96"
                    onChange={(text) => {
                      inputEdited.current = true
                      setDraft({ format: draft.format, text })
                    }}
                  />
                </div>
              )}
            </fieldset>
          </form>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          aria-label="Resize app input and run result"
        />
        <ResizablePanel
          id="app-result"
          defaultSize="50%"
          minSize="20%"
          overflow="hidden"
        >
          {traceId ? (
            <AppRunResult
              traceId={traceId}
              appId={app.id}
              running={running}
              onLoadInput={restoreRunInput}
            />
          ) : running ? (
            <LoadingState label="Running app and collecting traces" />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-foreground-muted">
              Run this app to see its captured traces.
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function AppRunResult({
  traceId,
  appId,
  running,
  onLoadInput,
}: {
  traceId: string
  appId: string
  running: boolean
  onLoadInput: (invocation: AppInvocation) => void
}) {
  const load = React.useCallback(
    (signal: AbortSignal) => loadPlaygroundRun(traceId, appId, signal),
    [traceId, appId]
  )
  const state = useRemote(load, [], { intervalMs: 2_000 })
  const [retained, setRetained] = React.useState(state.data)
  if (state.data && state.data !== retained) setRetained(state.data)
  const result = state.data ?? retained
  const waiting = running || (!state.error && result?.invocation.id !== traceId)
  React.useEffect(() => {
    if (state.data) onLoadInput(state.data.invocation)
  }, [state.data, onLoadInput])
  const failure =
    result?.invocation.status === "errored"
      ? result.invocation.attributes["error.message"]
      : null
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-busy={waiting}
      data-slot="playground-run-result"
    >
      {waiting && result && (
        <span role="status" className="sr-only">
          Running app and collecting traces
        </span>
      )}
      {state.error && (
        <Notice role="alert" variant="error">
          Could not load all captured traces. {state.error.message}{" "}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            Retry
          </Button>
        </Notice>
      )}
      {failure && (
        <Notice role="alert" variant="error">
          {String(failure)}
        </Notice>
      )}
      {result?.invocation.attributes["datool.scoring.error"] && (
        <Notice variant="error">
          {String(result.invocation.attributes["datool.scoring.error"])}
        </Notice>
      )}
      {result ? (
        <div
          inert={waiting}
          data-slot="playground-run-traces"
          className={`flex min-h-0 flex-1 flex-col ${waiting ? "blur-sm" : ""}`}
        >
          <RunTraceInspector
            key={result.invocation.id}
            traces={result.traces}
            evalRunId={typeof result.invocation.attributes["datool.eval.run.id"] === "string" ? result.invocation.attributes["datool.eval.run.id"] : undefined}
          />
        </div>
      ) : !state.error ? (
        <LoadingState label="Loading captured traces" />
      ) : null}
    </div>
  )
}
