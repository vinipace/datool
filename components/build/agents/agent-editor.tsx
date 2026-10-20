"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Copy,
  FileText,
  MessagesSquare,
  Globe,
  History,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Save,
  Check,
  LoaderCircle,
  Settings2,
  SquarePlus,
  Network,
  Trash2,
  Upload,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentAvatar, AgentAvatarPicker } from "@/components/ui/agent-avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { InspectorSection } from "@/components/ui/inspector-section"
import { LoadingState } from "@/components/ui/loading-state"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import {
  Select as CustomSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useRemote } from "@/components/tracer/hooks"
import { CollectionRow, CollectionTable, CollectionTableBody } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { ProjectModelField } from "@/components/tracer/project-model-field"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import {
  BuildErrorState,
  BuildStatus,
} from "@/components/build/shared/build-layout"
import { agentBuildTabs } from "@/components/build/shared/build-tabs"
import { AgentSidebarNavigation } from "@/components/build/shared/agent-sidebar"
import { channelLabel } from "@/components/build/shared/channel-catalog"
import { CopilotTab } from "./copilot-tab"
import { AgentOverview } from "./agent-overview"
import { KnowledgePages } from "./knowledge-pages"
import { KnowledgeSourceRow } from "./knowledge-source-row"
import { WidgetsTab } from "./widgets-tab"
import { AgentPlayground } from "./agent-playground"
import { ActionCatalog, ActionIcon, ActionTypeLabel } from "./action-catalog"
import {
  newActionDraft,
  withActionType,
  type ActionPreset,
} from "./action-presets"
import { ChannelsManager } from "@/components/build/operations/integrations-page"
import {
  buildCall,
  buildOperations,
  formatBuildError,
  listItems,
} from "@/components/build/shared/build-api"
import type {
  ActionDefinition,
  ActionRecord,
  AgentConfiguration,
  AgentRevision,
  BuildChannel,
  ManagedAgent,
  ProcedureDefinition,
  ProcedureRecord,
} from "@/src/lib/build/contracts"
import {
  agentDraft as defaultDraft,
  createAgentAutosave,
  validAgentDraft,
} from "@/src/lib/build/agent-autosave"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  type ModelProvider,
} from "@/src/lib/model-providers"
import type {
  KnowledgeSource,
  KnowledgeSourceDetail,
} from "@/src/lib/build/knowledge"
import { KNOWLEDGE_LIMITS } from "@/src/lib/build/knowledge"

type AgentEditorProps = { agent?: ManagedAgent; initialTab?: string }

const supportedChannelOptions: BuildChannel[] = ["web", "telegram"]

type AgentProvider = AgentConfiguration["provider"]

function modelProviderForAgentProvider(provider: AgentProvider): ModelProvider {
  return provider === "openai" ? OPENAI_PROVIDER : GATEWAY_PROVIDER
}

function modelForPicker(model: string, provider: AgentProvider) {
  let selected = model.trim()
  const pickerProvider = modelProviderForAgentProvider(provider)
  const transportPrefix = `${pickerProvider}/`
  if (selected.startsWith(transportPrefix))
    selected = selected.slice(transportPrefix.length)
  // Gateway catalog entries are namespaced by their upstream creator, while
  // older agent drafts may contain an unqualified model ID.
  if (
    pickerProvider === GATEWAY_PROVIDER &&
    selected &&
    !selected.includes("/")
  )
    selected = `openai/${selected}`
  return selected
}

function agentProviderForModelProvider(
  provider: ModelProvider,
  current: AgentProvider
): AgentProvider {
  if (provider === OPENAI_PROVIDER) return "openai"
  // Preserve the project route when a project-backed Gateway model is chosen;
  // the explicit gateway route remains available for a channel override.
  if (provider === GATEWAY_PROVIDER)
    return current === "project" ? "project" : "gateway"
  return current
}

export function NewBuildAgentPage() {
  return <BuildAgentEditor />
}

export function BuildAgentDetailPage({
  agentId,
  initialTab,
}: {
  agentId: string
  initialTab?: string
}) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      buildCall<ManagedAgent>(
        buildOperations.getAgent,
        { agentId, includeArchived: true },
        { signal }
      ),
    [agentId]
  )
  const state = useRemote(load, [agentId])
  if (state.error)
    return (
      <BuildErrorState message={state.error.message} onRetry={state.refresh} />
    )
  if (!state.data) return <LoadingState label="Loading Build agent" />
  return (
    <BuildAgentEditor
      key={`${agentId}:${state.data.currentRevision}`}
      agent={state.data}
      initialTab={initialTab}
    />
  )
}

export function BuildAgentEditor(props: AgentEditorProps) {
  return (
    <React.Suspense fallback={<LoadingState label="Loading Build editor" />}>
      <BuildAgentEditorContent {...props} />
    </React.Suspense>
  )
}

function BuildAgentEditorContent({
  agent,
  initialTab = agent ? "overview" : "settings",
}: AgentEditorProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const workspaceHref = useWorkspaceHref()
  const [store] = React.useState(() =>
    createAgentAutosave(agent, (draft, saved, changes) =>
      saved
        ? buildCall<ManagedAgent>(buildOperations.updateAgent, {
            agentId: saved.id,
            ...changes,
            expectedRevision: saved.currentRevision,
            apply: true,
          })
        : buildCall<ManagedAgent>(buildOperations.createAgent, draft)
    )
  )
  const saveState = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  const { saved, draft } = saveState
  // Keep existing Appearance bookmarks working after merging it into Settings.
  const sectionParam = searchParams.get("section")
  const requestedSection =
    sectionParam === "appearance" ? "settings" : sectionParam
  const initialSection = initialTab === "appearance" ? "settings" : initialTab
  const requestedIsAllowed =
    !!requestedSection &&
    agentBuildTabs.some((tab) => tab.id === requestedSection) &&
    (!!agent ||
      requestedSection === "settings" ||
      requestedSection === "instructions")
  const active =
    requestedIsAllowed && requestedSection
      ? requestedSection
      : agentBuildTabs.some((tab) => tab.id === initialSection)
        ? initialSection
        : "overview"
  const mainRef = React.useRef<HTMLElement>(null)
  const [visitedSections, setVisitedTabs] = React.useState(
    () => new Set([active])
  )
  const visitedTabs = new Set([...visitedSections, active])
  const [actionsView, setActionsView] = React.useState("mine")
  const pending = saveState.status === "saving"
  const [error, setError] = React.useState<string | null>(null)
  const dirty = store.pending()
  const valid = validAgentDraft(draft)

  const selectTab = React.useCallback(
    (next: string) => {
      if (!agentBuildTabs.some((tab) => tab.id === next)) return
      if (!saved && next !== "settings" && next !== "instructions") return
      mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" })
      setVisitedTabs((current) => {
        if (current.has(next)) return current
        return new Set([...current, next])
      })
      if (typeof window === "undefined") return
      const url = new URL(window.location.href)
      url.searchParams.set("section", next)
      if (url.href !== window.location.href)
        window.history.pushState(
          null,
          "",
          `${url.pathname}${url.search}${url.hash}`
        )
    },
    [saved]
  )

  React.useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" })
    React.startTransition(() => {
      setVisitedTabs((current) => {
        if (current.has(active)) return current
        return new Set([...current, active])
      })
    })
  }, [active])

  const save = React.useCallback(async () => {
    if (!valid) return
    setError(null)
    try {
      await store.flush()
      const next = store.getSnapshot().saved
      if (!agent && next)
        router.replace(
          workspaceHref(`/build/agents/${encodeURIComponent(next.id)}`)
        )
    } catch {
      // The queue retains the draft and exposes the error for retry.
    }
  }, [agent, router, store, valid, workspaceHref])

  React.useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!store.pending()) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      if (
        store.getSnapshot().saved &&
        store.pending() &&
        !store.getSnapshot().error
      )
        void store.flush().catch(() => {})
    }
  }, [store])

  async function cloneAgent(agentToClone: ManagedAgent) {
    try {
      const copy = await buildCall<ManagedAgent>(buildOperations.cloneAgent, {
        sourceAgentId: agentToClone.id,
        name: `${agentToClone.name} copy`,
      })
      router.push(workspaceHref(`/build/agents/${encodeURIComponent(copy.id)}`))
    } catch (reason) {
      setError(formatBuildError(reason))
    }
  }

  async function archiveAgent(agentToArchive: ManagedAgent) {
    if (
      !window.confirm(
        `Archive ${agentToArchive.name}? Existing conversations remain available.`
      )
    )
      return
    try {
      await buildCall(buildOperations.archiveAgent, {
        agentId: agentToArchive.id,
        expectedRevision: agentToArchive.currentRevision,
      })
      router.push(workspaceHref("/build/agents"))
    } catch (reason) {
      setError(formatBuildError(reason))
    }
  }

  React.useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (!event.repeat && dirty && valid && !pending) void save()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [dirty, pending, save, valid])

  function updateDraft<K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K]
  ) {
    store.update({ ...store.getSnapshot().draft, [key]: value })
    setError(null)
  }

  return (
    <Tabs
      value={actionsView}
      onValueChange={(value) => {
        setActionsView(value)
        mainRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" })
      }}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <AgentSidebarNavigation
        name={draft.name || "New agent"}
        appearance={draft.configuration.appearance}
        active={active}
        onChange={selectTab}
        canConfigure={Boolean(saved)}
      />
      <HeaderSlot name="title">
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar appearance={draft.configuration.appearance} />
          <h1 className="truncate text-sm font-medium">
            {draft.name || "New agent"}
          </h1>
          {saved ? <BuildStatus state={saved.status} /> : null}
        </div>
      </HeaderSlot>
      <HeaderSlot name="actions">
        {saved && saveState.status !== "idle" ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-foreground-muted"
          >
            {pending ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            {saveState.status === "saved" ? (
              <Check className="size-3.5" aria-hidden />
            ) : null}
            {pending
              ? "Saving…"
              : saveState.status === "saved"
                ? "Saved"
                : "Changes not saved"}
          </span>
        ) : null}
        {!saved ? (
          <Button
            type="button"
            size="sm"
            disabled={!valid}
            loading={pending}
            onClick={() => void save()}
          >
            <Plus className="size-3.5" />
            Create agent
          </Button>
        ) : null}
      </HeaderSlot>
      {saved ? (
        <HeaderSlot name="menu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More agent actions"
                title="More agent actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={dirty}
                onSelect={() => void cloneAgent(saved)}
              >
                <Copy className="size-3.5" />
                Clone agent
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={dirty}
                variant="destructive"
                onSelect={() => void archiveAgent(saved)}
              >
                <Archive className="size-3.5" />
                Archive agent
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </HeaderSlot>
      ) : null}
      {active === "actions" && saved ? (
        <div className="shrink-0 border-b border-border bg-muted/30 px-3">
          <TabsList variant="underline" aria-label="Actions">
            <TabsTrigger value="mine">
              <Zap className="size-4" />
              My Actions
            </TabsTrigger>
            <TabsTrigger value="create">
              <SquarePlus className="size-4" />
              Create Actions
            </TabsTrigger>
          </TabsList>
        </div>
      ) : null}
      {error || saveState.error ? (
        <BuildErrorState
          message={error ?? formatBuildError(saveState.error)}
          onRetry={saveState.error ? () => void save() : undefined}
        />
      ) : null}
      {saved && saveState.status === "invalid" ? (
        <Notice role="status" variant="warning" layout="banner">
          Complete the required fields and correct invalid settings to save your
          changes automatically.
        </Notice>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <main
          ref={mainRef}
          className={`min-h-0 min-w-0 flex-1 ${active === "playground" ? "overflow-hidden" : "overflow-y-auto"}`}
        >
          {active === "overview" && saved ? (
            <AgentOverview key={saved.id} agentId={saved.id} />
          ) : null}
          {visitedTabs.has("settings") || (!saved && active === "overview") ? (
            <div
              hidden={
                active !== "settings" && !(!saved && active === "overview")
              }
              aria-hidden={
                active !== "settings" && !(!saved && active === "overview")
              }
            >
              <SettingsTab
                agent={saved}
                draft={draft}
                onChange={updateDraft}
                onNavigate={selectTab}
              />
            </div>
          ) : null}
          {visitedTabs.has("instructions") ? (
            <div
              hidden={active !== "instructions"}
              aria-hidden={active !== "instructions"}
            >
              <InstructionsTab
                draft={draft}
                onChange={(configuration) =>
                  updateDraft("configuration", configuration)
                }
              />
            </div>
          ) : null}
          {visitedTabs.has("guardrails") ? (
            <div
              hidden={active !== "guardrails"}
              aria-hidden={active !== "guardrails"}
            >
              <GuardrailsTab
                draft={draft}
                onChange={(configuration) =>
                  updateDraft("configuration", configuration)
                }
              />
            </div>
          ) : null}
          {visitedTabs.has("copilot") && saved ? (
            <div
              hidden={active !== "copilot"}
              aria-hidden={active !== "copilot"}
            >
              <CopilotTab
                agentId={saved.id}
                onDefinitionDirty={store.definitionsChanged}
              />
            </div>
          ) : null}
          {visitedTabs.has("knowledge") && saved ? (
            <div
              hidden={active !== "knowledge"}
              aria-hidden={active !== "knowledge"}
            >
              <KnowledgeTab agentId={saved.id} />
            </div>
          ) : null}
          {visitedTabs.has("actions") && saved ? (
            <div
              hidden={active !== "actions"}
              aria-hidden={active !== "actions"}
            >
              <ActionsTab
                agentId={saved.id}
                onViewChange={setActionsView}
                onDefinitionDirty={store.definitionsChanged}
              />
            </div>
          ) : null}
          {visitedTabs.has("procedures") && saved ? (
            <div
              hidden={active !== "procedures"}
              aria-hidden={active !== "procedures"}
            >
              <ProceduresTab
                agentId={saved.id}
                onDefinitionDirty={store.definitionsChanged}
              />
            </div>
          ) : null}
          {visitedTabs.has("widgets") && saved ? (
            <div
              hidden={active !== "widgets"}
              className="h-full"
              aria-hidden={active !== "widgets"}
            >
              <WidgetsTab
                agentId={saved.id}
                onDefinitionDirty={store.definitionsChanged}
              />
            </div>
          ) : null}
          {visitedTabs.has("channels") && saved ? (
            <div
              hidden={active !== "channels"}
              aria-hidden={active !== "channels"}
            >
              <ChannelsManager fixedAgentId={saved.id} embedded />
            </div>
          ) : null}
          {active === "playground" && saved ? (
            <div className="h-full">
              <AgentPlayground agent={saved} />
            </div>
          ) : null}
          {!saved &&
          active !== "overview" &&
          active !== "settings" &&
          active !== "instructions" ? (
            <Notice variant="info" className="m-4">
              Save the agent before configuring {active}.
            </Notice>
          ) : null}
        </main>
      </div>
    </Tabs>
  )
}

function SettingsTab({
  agent,
  draft,
  onChange,
  onNavigate,
}: {
  agent?: ManagedAgent
  draft: ReturnType<typeof defaultDraft>
  onChange: <K extends keyof ReturnType<typeof defaultDraft>>(
    key: K,
    value: ReturnType<typeof defaultDraft>[K]
  ) => void
  onNavigate: (tab: string) => void
}) {
  const overviewAgentId = agent?.id
  const channelLoad = React.useCallback(
    (signal: AbortSignal) =>
      overviewAgentId
        ? buildCall<unknown>(
            buildOperations.listChannels,
            { agentId: overviewAgentId },
            { signal }
          ).then((value) => listItems<ChannelConnectionView>(value))
        : Promise.resolve<ChannelConnectionView[]>([]),
    [overviewAgentId]
  )
  const channelState = useRemote(channelLoad, [overviewAgentId])
  const hasConnectedChannel = Boolean(
    channelState.data?.some(
      (connection) =>
        connection.status === "connected" || connection.status === "paused"
    )
  )
  const steps = [
    {
      label: "Name your agent",
      done: Boolean(draft.name.trim()),
      tab: "settings",
    },
    {
      label: "Add instructions",
      done: Boolean(draft.configuration.instructions.trim()),
      tab: "instructions",
    },
    ...(agent
      ? [
          {
            label: "Connect a channel",
            done: hasConnectedChannel,
            tab: "channels",
          },
        ]
      : [{ label: "Save your first revision", done: false, tab: null }]),
  ]
  const nextStep = steps.find((step) => !step.done)
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <p className="text-xs font-medium tracking-[0.16em] text-foreground-subtle uppercase">
          Agent setup
        </p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          {agent ? "Settings" : "Create your agent"}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Manage your agent’s identity, appearance and welcome experience.
        </p>
      </div>
      <div className="max-w-3xl">
        <InspectorSection
          label="Identity"
          icon={<FileText className="size-3.5" />}
        >
          <FormRow label="Workspace name" htmlFor="agent-name">
            <Input
              id="agent-name"
              required
              maxLength={160}
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
            />
          </FormRow>
          <FormRow label="Slug" htmlFor="agent-slug">
            <Input
              id="agent-slug"
              required
              maxLength={160}
              pattern="[a-zA-Z0-9_.-]+"
              value={draft.slug}
              disabled={!!agent}
              onChange={(event) => onChange("slug", event.target.value)}
            />
          </FormRow>
          <InspectorSection label="Description" variant="form">
            <Textarea
              aria-label="Agent description"
              rows={3}
              autoSize
              maxLength={2000}
              value={draft.description}
              onChange={(event) => onChange("description", event.target.value)}
            />
          </InspectorSection>
        </InspectorSection>
        <AppearanceAndGuardrails
          section="appearance"
          config={draft.configuration}
          onChange={(configuration) => onChange("configuration", configuration)}
        />
        <InspectorSection
          label="Revision history"
          icon={<History className="size-3.5" />}
          defaultOpen={false}
        >
          {agent ? (
            <RevisionHistory key={agent.currentRevision} agentId={agent.id} />
          ) : (
            <p className="text-sm text-foreground-muted">
              Create the agent to start a revision history.
            </p>
          )}
        </InspectorSection>
        <InspectorSection label="Setup checklist" defaultOpen={!agent}>
          {agent && channelState.error ? (
            <BuildErrorState
              message={channelState.error.message}
              onRetry={channelState.refresh}
            />
          ) : null}
          <div className="space-y-2">
            {steps.map((step) => (
              <div key={step.label} className="flex items-start gap-2 text-sm">
                <span
                  aria-hidden
                  className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border text-[10px] ${step.done ? "border-success bg-success/15 text-success" : "border-border text-foreground-muted"}`}
                >
                  {step.done ? "✓" : ""}
                </span>
                <span
                  className={
                    step.done
                      ? "text-foreground-muted line-through"
                      : "text-foreground"
                  }
                >
                  {step.label}
                </span>
              </div>
            ))}
            {nextStep?.tab ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3 w-full justify-between"
                onClick={() =>
                  onNavigate(
                    nextStep.label === "Add instructions"
                      ? "instructions"
                      : nextStep.tab
                  )
                }
              >
                {nextStep.label}
                <ArrowLeft className="size-3.5 rotate-180" />
              </Button>
            ) : nextStep ? (
              <p className="mt-3 text-xs leading-5 text-foreground-muted">
                Use Create agent in the header when the identity and
                instructions are ready. Future edits save automatically.
              </p>
            ) : null}
          </div>
        </InspectorSection>
      </div>
    </div>
  )
}

function RevisionHistory({ agentId }: { agentId: string }) {
  const state = useRemote(
    React.useCallback(
      (signal: AbortSignal) =>
        buildCall<unknown>(
          buildOperations.listAgentRevisions,
          { agentId },
          { signal }
        ).then((value) => listItems<AgentRevision>(value)),
      [agentId]
    ),
    [agentId]
  )
  if (state.error)
    return (
      <Notice role="alert" variant="error">
        {state.error.message}
      </Notice>
    )
  if (!state.data) return <LoadingState compact label="Loading revisions" />
  if (!state.data.length)
    return <p className="text-sm text-foreground-muted">No revisions yet.</p>
  return <RevisionList agentId={agentId} revisions={state.data} />
}

function RevisionList({
  agentId,
  revisions,
}: {
  agentId: string
  revisions: AgentRevision[]
}) {
  const [restoring, setRestoring] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function restore(revision: AgentRevision) {
    if (
      restoring !== null ||
      !window.confirm(
        `Restore revision ${revision.revision} as the new applied revision?`
      )
    )
      return
    setRestoring(revision.revision)
    setError(null)
    try {
      const current = revisions[0]?.revision ?? revision.revision
      await buildCall(buildOperations.applyAgentRevision, {
        agentId,
        sourceRevision: revision.revision,
        expectedRevision: current,
      })
      window.location.reload()
    } catch (reason) {
      setError(formatBuildError(reason))
      setRestoring(null)
    }
  }

  return (
    <div className="space-y-2">
      {error ? (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      ) : null}
      <div className="divide-y divide-border rounded-md border border-border">
        {revisions.map((revision) => (
          <div
            key={revision.id}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span>Revision {revision.revision}</span>
            <span className="text-xs text-foreground-muted">
              {revision.state} · {formatDate(revision.createdAt)}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={revision.state === "applied" || restoring !== null}
              loading={restoring === revision.revision}
              onClick={() => void restore(revision)}
            >
              Restore
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function InstructionsTab({
  draft,
  onChange,
}: {
  draft: ReturnType<typeof defaultDraft>
  onChange: (configuration: AgentConfiguration) => void
}) {
  const config = draft.configuration
  const updateConfig = (patch: Partial<AgentConfiguration>) =>
    onChange({ ...config, ...patch })

  return (
    <div className="mx-auto grid w-full max-w-6xl min-w-0 grid-cols-1 items-start gap-5 px-4 py-6 sm:px-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section
        className="min-w-0 space-y-3"
        aria-labelledby="agent-instructions-heading"
      >
        <div className="space-y-1">
          <h2 id="agent-instructions-heading" className="text-sm font-semibold">
            System instructions
          </h2>
          <p
            id="agent-instructions-description"
            className="text-sm text-foreground-muted"
          >
            Define your agent’s role, tone and how it should help customers.
          </p>
        </div>
        <Textarea
          aria-label="System instructions"
          aria-describedby="agent-instructions-description"
          autoSize
          minRows={8}
          maxLength={64_000}
          value={config.instructions}
          onChange={(event) =>
            updateConfig({ instructions: event.target.value })
          }
        />
      </section>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Model settings</CardTitle>
        </CardHeader>
        <CardContent className="min-w-0 space-y-5 pt-4">
          <ProjectModelField
            layout="vertical"
            variant="plain"
            model={modelForPicker(config.model, config.provider)}
            provider={modelProviderForAgentProvider(config.provider)}
            onChange={({ provider, model }) =>
              updateConfig({
                provider: agentProviderForModelProvider(
                  provider,
                  config.provider
                ),
                model,
              })
            }
          />
          <FormRow
            label="Temperature"
            htmlFor="agent-temperature"
            layout="vertical"
            variant="plain"
          >
            <div className="flex min-w-0 items-center gap-3">
              <Slider
                aria-label="Temperature slider"
                className="min-w-0 flex-1"
                min={0}
                max={2}
                step={0.1}
                value={[config.temperature]}
                onValueChange={([temperature]) => updateConfig({ temperature })}
              />
              <Input
                id="agent-temperature"
                className="w-20 shrink-0"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={config.temperature}
                onChange={(event) => {
                  const temperature = event.currentTarget.valueAsNumber
                  if (Number.isFinite(temperature))
                    updateConfig({
                      temperature: Math.min(2, Math.max(0, temperature)),
                    })
                }}
              />
            </div>
            <p className="mt-2 text-xs text-foreground-muted">
              Lower values keep answers consistent. Higher values add variety.
            </p>
          </FormRow>
        </CardContent>
      </Card>
    </div>
  )
}

function GuardrailsTab({
  draft,
  onChange,
}: {
  draft: ReturnType<typeof defaultDraft>
  onChange: (configuration: AgentConfiguration) => void
}) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <p className="text-xs font-medium tracking-[0.16em] text-foreground-subtle uppercase">
          Agent safety
        </p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          Guardrails
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Set the safety, usage and abuse limits that protect customers and your
          budget.
        </p>
      </div>
      <AppearanceAndGuardrails
        section="guardrails"
        config={draft.configuration}
        onChange={onChange}
      />
    </div>
  )
}

function AppearanceAndGuardrails({
  config,
  onChange,
  section = "both",
}: {
  config: AgentConfiguration
  onChange: (configuration: AgentConfiguration) => void
  section?: "both" | "appearance" | "guardrails"
}) {
  const appearance = config.appearance
  const guardrails = config.guardrails
  return (
    <div
      className={section === "both" ? "grid gap-4 xl:grid-cols-2" : "max-w-3xl"}
    >
      {section !== "guardrails" ? (
        <InspectorSection
          label="Appearance"
          icon={<Globe className="size-3.5" />}
          defaultOpen={section !== "both"}
        >
          <FormRow label="Display name" htmlFor="appearance-name">
            <Input
              id="appearance-name"
              value={appearance.displayName}
              onChange={(event) =>
                onChange({
                  ...config,
                  appearance: {
                    ...appearance,
                    displayName: event.target.value,
                  },
                })
              }
            />
          </FormRow>
          <FormRow label="Avatar" layout="vertical">
            <AgentAvatarPicker
              value={appearance}
              onChange={(next) => onChange({ ...config, appearance: next })}
            />
          </FormRow>
          <FormRow label="Custom image URL" htmlFor="appearance-avatar">
            <Input
              id="appearance-avatar"
              type="url"
              placeholder="https://…"
              value={appearance.avatarUrl ?? ""}
              onChange={(event) =>
                onChange({
                  ...config,
                  appearance: {
                    ...appearance,
                    avatarUrl: event.target.value || null,
                  },
                })
              }
            />
          </FormRow>
          <InspectorSection label="Welcome message" variant="form">
            <Textarea
              aria-label="Welcome message"
              rows={3}
              autoSize
              value={appearance.welcomeMessage}
              onChange={(event) =>
                onChange({
                  ...config,
                  appearance: {
                    ...appearance,
                    welcomeMessage: event.target.value,
                  },
                })
              }
            />
          </InspectorSection>
          <FormRow label="Input placeholder" htmlFor="appearance-placeholder">
            <Input
              id="appearance-placeholder"
              value={appearance.inputPlaceholder}
              onChange={(event) =>
                onChange({
                  ...config,
                  appearance: {
                    ...appearance,
                    inputPlaceholder: event.target.value,
                  },
                })
              }
            />
          </FormRow>
          <InspectorSection label="Suggested replies" variant="form">
            <Textarea
              aria-label="Suggested replies"
              rows={3}
              autoSize
              placeholder="One reply per line"
              value={appearance.suggestedReplies.join("\n")}
              onChange={(event) =>
                onChange({
                  ...config,
                  appearance: {
                    ...appearance,
                    suggestedReplies: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  },
                })
              }
            />
          </InspectorSection>
        </InspectorSection>
      ) : null}
      {section !== "appearance" ? (
        <InspectorSection
          label="Guardrails"
          icon={<Settings2 className="size-3.5" />}
          defaultOpen
        >
          <InspectorSection label="Safety" variant="form" defaultOpen>
            <InspectorSection label="Blocked topics" variant="form">
              <Textarea
                aria-label="Blocked topics"
                rows={3}
                autoSize
                placeholder="One topic per line"
                value={guardrails.blockedTopics.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      blockedTopics: event.target.value
                        .split("\n")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </InspectorSection>
            <InspectorSection label="Blocked countries" variant="form">
              <Textarea
                aria-label="Blocked countries"
                rows={2}
                autoSize
                placeholder={"BR\nUS"}
                value={guardrails.blockedCountries.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      blockedCountries: event.target.value
                        .split("\n")
                        .map((item) => item.trim().toUpperCase())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </InspectorSection>
            <FormRow
              label="Require human for actions"
              htmlFor="guardrail-human"
            >
              <Switch
                id="guardrail-human"
                checked={guardrails.requireHumanForActions}
                onCheckedChange={(value) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      requireHumanForActions: value,
                    },
                  })
                }
              />
            </FormRow>
          </InspectorSection>
          <InspectorSection
            label="Usage limits and budget"
            variant="form"
            defaultOpen
          >
            <FormRow label="Max input characters" htmlFor="guardrail-input">
              <Input
                id="guardrail-input"
                type="number"
                min={1}
                max={100000}
                value={guardrails.maxInputCharacters}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      maxInputCharacters: Number(event.target.value),
                    },
                  })
                }
              />
            </FormRow>
            <FormRow label="Max output tokens" htmlFor="guardrail-output">
              <Input
                id="guardrail-output"
                type="number"
                min={1}
                max={64000}
                value={guardrails.maxOutputTokens}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      maxOutputTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </FormRow>
            <FormRow label="Max turns" htmlFor="guardrail-turns">
              <Input
                id="guardrail-turns"
                type="number"
                min={1}
                max={200}
                value={guardrails.maxTurns}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      maxTurns: Number(event.target.value),
                    },
                  })
                }
              />
            </FormRow>
            <FormRow label="Daily turn limit" htmlFor="guardrail-daily-turns">
              <Input
                id="guardrail-daily-turns"
                type="number"
                min={1}
                max={10000000}
                value={guardrails.dailyTurnLimit ?? ""}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      dailyTurnLimit: event.target.value
                        ? Number(event.target.value)
                        : null,
                    },
                  })
                }
              />
            </FormRow>
            <FormRow label="Daily budget (USD)" htmlFor="guardrail-budget">
              <Input
                id="guardrail-budget"
                type="number"
                min={0}
                max={1000000}
                step={0.01}
                value={guardrails.dailyBudgetUsd ?? ""}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      dailyBudgetUsd: event.target.value
                        ? Number(event.target.value)
                        : null,
                    },
                  })
                }
              />
            </FormRow>
          </InspectorSection>
          <InspectorSection
            label="Abuse protection"
            variant="form"
            defaultOpen={false}
          >
            <p className="mb-3 text-xs text-foreground-muted">
              Protect access from bursts and repeated messages. These limits are
              optional and apply in addition to the usage controls above.
            </p>
            <FormRow label="Requests per minute" htmlFor="guardrail-rpm">
              <Input
                id="guardrail-rpm"
                type="number"
                min={1}
                max={100000}
                value={guardrails.requestsPerMinute}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      requestsPerMinute: Number(event.target.value),
                    },
                  })
                }
              />
            </FormRow>
            <FormRow
              label="Max concurrent turns"
              htmlFor="guardrail-concurrency"
            >
              <Input
                id="guardrail-concurrency"
                type="number"
                min={1}
                max={1000}
                value={guardrails.maxConcurrentTurns}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      maxConcurrentTurns: Number(event.target.value),
                    },
                  })
                }
              />
            </FormRow>
            <FormRow label="Spam after messages" htmlFor="guardrail-spam">
              <Input
                id="guardrail-spam"
                type="number"
                min={2}
                max={100}
                value={guardrails.spamAfterMessages ?? ""}
                onChange={(event) =>
                  onChange({
                    ...config,
                    guardrails: {
                      ...guardrails,
                      spamAfterMessages: event.target.value
                        ? Number(event.target.value)
                        : null,
                    },
                  })
                }
              />
            </FormRow>
          </InspectorSection>
        </InspectorSection>
      ) : null}
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}

const knowledgeSourceTypes = {
  text: { label: "Text", icon: FileText },
  qa: { label: "Q&A pairs", icon: MessagesSquare },
  file: { label: "File", icon: Upload },
  website: { label: "Website", icon: Globe },
  sitemap: { label: "Sitemap", icon: Network },
}

function KnowledgeTab({ agentId }: { agentId: string }) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      buildCall<unknown>(
        buildOperations.listKnowledge,
        { agentId },
        { signal }
      ).then((value) => listItems<KnowledgeSource>(value)),
    [agentId]
  )
  const state = useRemote(load, [agentId], {
    intervalMs: 3_000,
    shouldPoll: (sources) =>
      Boolean(
        sources?.some(
          (source) =>
            source.status === "pending" || source.status === "indexing"
        )
      ),
  })
  const [kind, setKind] = React.useState<
    "text" | "qa" | "website" | "sitemap" | "file"
  >("text")
  const [name, setName] = React.useState("")
  const [text, setText] = React.useState("")
  const [pairs, setPairs] = React.useState([
    { id: "first", question: "", answer: "" },
  ])
  const pairFieldId = React.useId()
  const [url, setUrl] = React.useState("")
  const [maxPages, setMaxPages] = React.useState<number>(
    KNOWLEDGE_LIMITS.maxCrawlPages
  )
  const [file, setFile] = React.useState<File | null>(null)
  const [selected, setSelected] = React.useState<KnowledgeSource | null>(null)
  const [loadingSource, setLoadingSource] = React.useState(false)
  const [sourceLoaded, setSourceLoaded] = React.useState(false)
  const sourceRequest = React.useRef<AbortController | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [showSource, setShowSource] = React.useState(false)
  const rows = state.data ?? []
  const SourceTypeIcon = knowledgeSourceTypes[kind].icon
  const sourceFields = (
    <>
      <FormRow
        label="Name"
        htmlFor="source-name"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="source-name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={
            kind === "qa"
              ? "e.g. Shipping and returns"
              : "e.g. Support handbook"
          }
        />
      </FormRow>
      {kind === "website" || kind === "sitemap" ? (
        <FormRow
          label="URL"
          htmlFor="source-url"
          layout="vertical"
          variant="plain"
        >
          <Input
            id="source-url"
            type="text"
            inputMode="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={
              kind === "sitemap"
                ? "https://example.com/sitemap.xml"
                : "https://example.com/docs"
            }
          />
        </FormRow>
      ) : null}
      {kind === "website" || kind === "sitemap" ? (
        <FormRow
          label="Maximum pages"
          htmlFor="source-max-pages"
          layout="vertical"
          variant="plain"
        >
          <Input
            id="source-max-pages"
            type="number"
            min={1}
            max={KNOWLEDGE_LIMITS.maxCrawlPages}
            required
            value={maxPages}
            onChange={(event) => setMaxPages(Number(event.target.value))}
          />
        </FormRow>
      ) : null}
    </>
  )

  React.useEffect(() => () => sourceRequest.current?.abort(), [])

  async function saveSource(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim() || pending || loadingSource || (selected && !sourceLoaded))
      return
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const input: Record<string, unknown> = {
        source: selected
          ? {
              sourceId: selected.id,
              name: name.trim(),
              expectedRevision: selected.revision,
            }
          : { agentId, name: name.trim(), kind },
      }
      const source = input.source as Record<string, unknown>
      if (kind === "text") source.text = text
      if (kind === "qa") {
        source.pairs = pairs.map(({ question, answer }) => ({
          question: question.trim(),
          answer: answer.trim(),
        }))
        if (
          pairs.some(
            ({ question, answer }) => !question.trim() || !answer.trim()
          )
        )
          throw new Error("Add a question and answer for each pair.")
      }
      if (kind === "website" || kind === "sitemap") {
        source.url = /^https?:\/\//i.test(url.trim())
          ? url.trim()
          : `https://${url.trim()}`
        source.config = { maxPages }
      }
      if (kind === "file" && !selected) {
        if (!file) throw new Error("Choose a file first.")
        source.fileName = file.name
        source.mimeType = file.type
        source.contentBase64 = await readFileBase64(file)
      }
      await buildCall(
        selected
          ? buildOperations.updateKnowledge
          : buildOperations.createKnowledge,
        input
      )
      setMessage(
        selected
          ? "Source saved. Indexing updated content."
          : "Knowledge source added and indexing started."
      )
      setShowSource(false)
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }

  function openSourceDialog(nextKind: typeof kind = "text") {
    sourceRequest.current?.abort()
    setSelected(null)
    setLoadingSource(false)
    setSourceLoaded(false)
    setKind(nextKind)
    setName("")
    setText("")
    setPairs([{ id: "first", question: "", answer: "" }])
    setUrl("")
    setMaxPages(KNOWLEDGE_LIMITS.maxCrawlPages)
    setFile(null)
    setError(null)
    setMessage(null)
    setShowSource(true)
  }

  async function openExistingSource(source: KnowledgeSource) {
    sourceRequest.current?.abort()
    const request = new AbortController()
    sourceRequest.current = request
    setSelected(source)
    setKind(source.kind)
    setSourceLoaded(false)
    setLoadingSource(true)
    setError(null)
    setMessage(null)
    setShowSource(true)
    try {
      const detail = await buildCall<KnowledgeSourceDetail>(
        buildOperations.getKnowledge,
        { sourceId: source.id },
        { signal: request.signal }
      )
      if (request.signal.aborted) return
      setSelected(detail)
      setName(detail.name)
      setText(detail.text)
      setUrl(detail.uri ?? "")
      setMaxPages(detail.config?.maxPages ?? KNOWLEDGE_LIMITS.maxCrawlPages)
      setFile(null)
      setPairs(
        detail.pairs.length
          ? detail.pairs.map((pair, index) => ({ ...pair, id: String(index) }))
          : [{ id: "first", question: "", answer: "" }]
      )
      setSourceLoaded(true)
    } catch (reason) {
      if (!request.signal.aborted) setError(formatBuildError(reason))
    } finally {
      if (!request.signal.aborted) setLoadingSource(false)
    }
  }

  function handleSourceDialogChange(open: boolean) {
    if (!open && pending) return
    if (!open) sourceRequest.current?.abort()
    setShowSource(open)
    setError(null)
  }

  async function removeSource(source: KnowledgeSource) {
    if (!window.confirm(`Delete ${source.name}?`)) return
    setError(null)
    setMessage(null)
    try {
      await buildCall(buildOperations.deleteKnowledge, { sourceId: source.id })
      setSelected(null)
      setMessage("Source deleted.")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    }
  }

  async function resync(source: KnowledgeSource) {
    setError(null)
    setMessage(null)
    try {
      await buildCall(buildOperations.indexKnowledge, { sourceId: source.id })
      setMessage("Indexing queued.")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    }
  }

  return (
    <div className="w-full min-w-0 space-y-5 px-4 py-6 sm:px-6">
      {error && !showSource ? (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      ) : null}
      {message ? (
        <Notice role="status" variant="success">
          {message}
        </Notice>
      ) : null}
      <div
        aria-label="Add knowledge"
        className="grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4"
      >
        {[
          {
            value: "text" as const,
            label: "Text",
            detail: "Paste a handbook or policy.",
            icon: FileText,
          },
          {
            value: "qa" as const,
            label: "Q&A",
            detail: "Add direct customer answers.",
            icon: MessagesSquare,
          },
          {
            value: "website" as const,
            label: "Website",
            detail: "Import pages from your website.",
            icon: Globe,
          },
          {
            value: "file" as const,
            label: "File",
            detail: "Upload a document to index.",
            icon: Upload,
          },
        ].map((choice) => (
          <Card key={choice.value} className="min-w-0">
            <CardAction
              aria-label={`Add ${choice.label.toLowerCase()}`}
              onClick={() => openSourceDialog(choice.value)}
            >
              <div className="flex items-center gap-3">
                <choice.icon
                  aria-hidden
                  className="size-5 shrink-0 text-foreground-muted"
                />
                <span className="text-sm font-medium">{choice.label}</span>
                <Plus
                  aria-hidden
                  className="ml-auto size-4 text-foreground-muted"
                />
              </div>
              <p className="text-xs text-foreground-muted">{choice.detail}</p>
            </CardAction>
          </Card>
        ))}
      </div>
      <Sheet open={showSource} onOpenChange={handleSourceDialogChange}>
        <SheetContent
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault()
          }}
        >
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <SheetTitle>
              {selected ? "Edit" : "Add"}{" "}
              {
                {
                  text: "text",
                  qa: "Q&A",
                  file: "file",
                  website: "website",
                  sitemap: "sitemap",
                }[kind]
              }
            </SheetTitle>
            <SheetDescription>
              {
                {
                  text: "Give your agent reference material to answer from.",
                  qa: "Teach your agent how to answer common customer questions.",
                  file: "Upload a document for your agent to learn from.",
                  website: "Add a website your agent can use as a source.",
                  sitemap: "Import pages listed in your website’s sitemap.",
                }[kind]
              }
            </SheetDescription>
          </SheetHeader>
          <form
            onSubmit={(event) => void saveSource(event)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <fieldset
              disabled={pending || loadingSource}
              className={selected && (kind === "website" || kind === "sitemap")
                ? "flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-hidden p-6"
                : "min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto p-6"}
            >
              {error ? (
                <Notice role="alert" variant="error">
                  {error}
                </Notice>
              ) : null}
              {loadingSource ? (
                <LoadingState compact label="Loading source" />
              ) : selected && !sourceLoaded ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openExistingSource(selected)}
                >
                  <RefreshCw className="size-4" />
                  Try again
                </Button>
              ) : (
                <>
                  {selected ? (
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="flex items-center gap-2 text-foreground-muted">
                        <SourceTypeIcon aria-hidden className="size-4" />
                        {knowledgeSourceTypes[kind].label}
                      </span>
                      <BuildStatus state={selected.status} />
                      <span className="text-xs text-foreground-muted">
                        Revision {selected.revision}
                      </span>
                    </div>
                  ) : (
                    <FormRow
                      label="Type"
                      htmlFor="source-kind"
                      layout="vertical"
                      variant="plain"
                    >
                      <CustomSelect
                        value={kind}
                        disabled={pending}
                        items={Object.entries(knowledgeSourceTypes).map(
                          ([value, type]) => ({ value, label: type.label })
                        )}
                        onValueChange={(value) => {
                          if (value) setKind(value as typeof kind)
                        }}
                      >
                        <SelectTrigger id="source-kind" className="w-full">
                          <span className="flex min-w-0 items-center gap-2">
                            <SourceTypeIcon
                              aria-hidden
                              className="size-4 shrink-0 text-foreground-muted"
                            />
                            <SelectValue />
                          </span>
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          {Object.entries(knowledgeSourceTypes).map(
                            ([value, type]) => (
                              <SelectItem key={value} value={value}>
                                <span className="flex items-center gap-2">
                                  <type.icon
                                    aria-hidden
                                    className="size-4 shrink-0 text-foreground-muted"
                                  />
                                  {type.label}
                                </span>
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </CustomSelect>
                    </FormRow>
                  )}
                  {selected?.statusMessage && !(selected.status === "ready" && /^\d+ pages indexed\.$/.test(selected.statusMessage)) ? (
                    <Notice
                      variant={selected.status === "error" ? "error" : "info"}
                    >
                      {selected.statusMessage}
                    </Notice>
                  ) : null}
                  {selected && (kind === "website" || kind === "sitemap") ? (
                    <KnowledgePages
                      key={`${selected.id}:${selected.activeRevision}`}
                      sourceId={selected.id}
                      settings={<div className="space-y-6">{sourceFields}</div>}
                    />
                  ) : (
                    sourceFields
                  )}
                  {kind === "file" && !selected ? (
                    <FormRow
                      label="File"
                      htmlFor="source-file"
                      layout="vertical"
                      variant="plain"
                    >
                      <Input
                        id="source-file"
                        type="file"
                        required={!file}
                        onChange={(event) =>
                          setFile(event.target.files?.[0] ?? null)
                        }
                      />
                      {file ? (
                        <p className="mt-2 text-xs break-all text-foreground-muted">
                          Selected: {file.name}
                        </p>
                      ) : null}
                    </FormRow>
                  ) : null}
                  {kind === "file" && selected ? (
                    <FormRow label="File" layout="vertical" variant="plain">
                      <p className="text-sm break-all">{selected.fileName}</p>
                      <p className="text-xs text-foreground-muted">
                        To replace this document, add a new file source.
                      </p>
                    </FormRow>
                  ) : null}
                  {kind === "text" || (kind === "file" && selected) ? (
                    <FormRow
                      label={kind === "file" ? "Extracted text" : "Text"}
                      htmlFor="source-content"
                      layout="vertical"
                      variant="plain"
                    >
                      <Textarea
                        id="source-content"
                        aria-label="Source content"
                        required
                        readOnly={kind === "file"}
                        rows={12}
                        autoSize
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        placeholder="Paste the information your agent should know…"
                      />
                    </FormRow>
                  ) : null}
                  {kind === "qa" ? (
                    <div className="space-y-4">
                      {pairs.map((pair, index) => (
                        <div
                          key={pair.id}
                          role="group"
                          aria-label={`Q&A ${index + 1}`}
                          className="space-y-4 rounded-lg border border-border p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-medium">
                              Question {index + 1}
                            </h3>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove question ${index + 1}`}
                              disabled={pairs.length === 1}
                              onClick={() =>
                                setPairs((current) =>
                                  current.filter((item) => item.id !== pair.id)
                                )
                              }
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                          <FormRow
                            label="Question"
                            htmlFor={`${pairFieldId}-${pair.id}-question`}
                            layout="vertical"
                            variant="plain"
                          >
                            <Textarea
                              id={`${pairFieldId}-${pair.id}-question`}
                              required
                              maxLength={4000}
                              rows={2}
                              autoSize
                              value={pair.question}
                              placeholder="e.g. How long does shipping take?"
                              onChange={(event) =>
                                setPairs((current) =>
                                  current.map((item) =>
                                    item.id === pair.id
                                      ? {
                                          ...item,
                                          question: event.target.value,
                                        }
                                      : item
                                  )
                                )
                              }
                            />
                          </FormRow>
                          <FormRow
                            label="Answer"
                            htmlFor={`${pairFieldId}-${pair.id}-answer`}
                            layout="vertical"
                            variant="plain"
                          >
                            <Textarea
                              id={`${pairFieldId}-${pair.id}-answer`}
                              required
                              maxLength={16000}
                              rows={5}
                              autoSize
                              value={pair.answer}
                              placeholder="Write the answer your agent should use…"
                              onChange={(event) =>
                                setPairs((current) =>
                                  current.map((item) =>
                                    item.id === pair.id
                                      ? { ...item, answer: event.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </FormRow>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() =>
                          setPairs((current) => [
                            ...current,
                            {
                              id: crypto.randomUUID(),
                              question: "",
                              answer: "",
                            },
                          ])
                        }
                      >
                        <Plus className="size-4" />
                        Add another question
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </fieldset>
            <SheetFooter className="shrink-0 border-t border-border px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <SheetClose asChild>
                <Button type="button" variant="ghost" disabled={pending}>
                  Cancel
                </Button>
              </SheetClose>
              <Button
                type="submit"
                loading={pending}
                disabled={loadingSource || Boolean(selected && !sourceLoaded)}
              >
                {selected ? (
                  <Save className="size-3.5" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                {selected ? "Save changes" : "Add source"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
      <section aria-label="Knowledge sources" className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">
            Sources
            {state.data ? (
              <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-normal text-foreground-muted tabular-nums">
                {rows.length}
              </span>
            ) : null}
          </h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh sources"
              loading={state.isLoading}
              onClick={state.refresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button type="button" size="sm" onClick={() => openSourceDialog()}>
              <Plus className="size-3.5" />
              Add source
            </Button>
          </div>
        </div>
        <CollectionTable
          widths={[360, 140, 120, 180, 88]}
          columnIds={["name", "content", "status", "indexed", "actions"]}
          actionColumnIds={["actions"]}
          selectionColumnWidth={0}
          displayControls={false}
          enableRowHeight={false}
          enableCardView={false}
          reorderable={false}
        >
          <thead className={collectionTable.head}>
            <tr>
              <th aria-hidden className="p-0" />
              {["Source", "Content", "Status", "Last indexed"].map((label) => (
                <th key={label} className={`${collectionTable.heading} border-r-0`}>
                  {label}
                </th>
              ))}
              <th className={`${collectionTable.heading} border-r-0`}>
                <span className="sr-only">Source actions</span>
              </th>
            </tr>
          </thead>
          <CollectionTableBody rows={rows} empty={null}>
            {(source) => (
              <KnowledgeSourceRow
                key={source.id}
                source={source}
                icon={knowledgeSourceTypes[source.kind].icon}
                kindLabel={knowledgeSourceTypes[source.kind].label}
                onOpen={() => void openExistingSource(source)}
                onReindex={() => void resync(source)}
                onDelete={() => void removeSource(source)}
              />
            )}
          </CollectionTableBody>
        </CollectionTable>
        {rows.length === 0 ? (
          <div className="px-4 py-16 text-center">
            {state.error ? (
              <BuildErrorState
                message={state.error.message}
                onRetry={state.refresh}
              />
            ) : state.data === null ? (
              <LoadingState compact label="Loading knowledge sources" />
            ) : (
              <>
                <FileText
                  aria-hidden
                  className="mx-auto mb-3 size-6 text-foreground-muted"
                />
                <p className="font-medium">No knowledge sources yet</p>
                <p className="mt-1 text-sm text-foreground-muted">
                  Choose a source type above to give your agent context.
                </p>
              </>
            )}
          </div>
        ) : null}
        {state.error && rows.length ? (
          <BuildErrorState
            message={state.error.message}
            onRetry={state.refresh}
          />
        ) : null}
      </section>
    </div>
  )
}

function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("Unable to read file."))
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
    reader.readAsDataURL(file)
  })
}

function ResourceEditorPrompt({
  resource,
  description,
  actionLabel,
  onCreate,
}: {
  resource: string
  description: string
  actionLabel: string
  onCreate: () => void
}) {
  return (
    <Card className="self-start border-dashed">
      <CardHeader>
        <CardTitle>
          Select or create {resource === "action" ? "an" : "a"}{" "}
          {resource.toLowerCase()}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          {actionLabel}
        </Button>
      </CardContent>
    </Card>
  )
}

function ActionsTab({
  agentId,
  onViewChange,
  onDefinitionDirty,
}: {
  agentId: string
  onViewChange: (value: string) => void
  onDefinitionDirty?: () => void
}) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      buildCall<unknown>(
        buildOperations.listActions,
        { agentId },
        { signal }
      ).then((value) => listItems<ActionRecord>(value)),
    [agentId]
  )
  const state = useRemote(load, [agentId])
  const [selected, setSelected] = React.useState<ActionRecord | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [draft, setDraft] = React.useState<ActionDefinition>(() =>
    newActionDraft("http")
  )
  const [editorKey, setEditorKey] = React.useState(0)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const rows = state.data ?? []
  const futureChannels = draft.channels.filter(
    (item) => !supportedChannelOptions.includes(item)
  )
  const update = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }) as ActionDefinition)
  function beginAction(preset: ActionPreset = "http") {
    setEditorKey((key) => key + 1)
    setSelected(null)
    setIsCreating(true)
    setDraft(newActionDraft(preset))
    setError(null)
    setMessage(null)
  }
  function selectAction(action: ActionRecord) {
    setEditorKey((key) => key + 1)
    setSelected(action)
    setIsCreating(false)
    setDraft(action.definition)
    setError(null)
    setMessage(null)
  }
  function clearAction() {
    setSelected(null)
    setIsCreating(false)
    setError(null)
    setMessage(null)
  }
  async function saveAction(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !draft.id.trim() || !draft.name.trim()) return
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const input = {
        agentId,
        id: selected?.id ?? draft.id,
        slug: draft.id,
        definition: draft,
        ...(selected ? { expectedRevision: selected.revision } : {}),
      }
      await buildCall<ActionRecord>(
        selected ? buildOperations.updateAction : buildOperations.createAction,
        input
      )
      onDefinitionDirty?.()
      setSelected(null)
      setIsCreating(false)
      setMessage(selected ? "Action updated." : "Action created.")
      onViewChange("mine")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  async function deleteAction(action: ActionRecord) {
    if (pending || !window.confirm(`Delete ${action.definition.name}?`)) return
    setPending(true)
    setError(null)
    try {
      await buildCall(buildOperations.deleteAction, {
        agentId,
        actionId: action.id,
        expectedRevision: action.revision,
      })
      onDefinitionDirty?.()
      if (selected?.id === action.id) clearAction()
      setMessage("Action deleted.")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="w-full min-w-0 space-y-8 px-4 py-6 sm:px-6">
      {error && !selected && !isCreating ? (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      ) : null}
      {message ? (
        <Notice role="status" variant="success">
          {message}
        </Notice>
      ) : null}
      <TabsContent value="create">
        <ActionCatalog onCreate={beginAction} />
      </TabsContent>
      <TabsContent value="mine" className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">
            My Actions{" "}
            <span className="ml-1 font-normal text-foreground-muted">
              {state.data ? rows.length : ""}
            </span>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh actions"
            loading={state.isLoading}
            onClick={state.refresh}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        {state.error ? (
          <BuildErrorState
            message={state.error.message}
            onRetry={state.refresh}
          />
        ) : null}
        {state.data === null && !state.error ? (
          <LoadingState compact label="Loading actions" />
        ) : rows.length ? (
          <CollectionTable
            widths={[300, 160, 360, 120, 90]}
            columnIds={["name", "type", "description", "status", "revision"]}
            displayControls={false}
            enableRowHeight={false}
            enableCardView={false}
            reorderable={false}
          >
            <thead className={collectionTable.head}>
              <tr>
                <th aria-hidden className={collectionTable.heading} />
                {["Action", "Type", "Description", "Status", "Revision"].map(
                  (label) => (
                    <th key={label} className={collectionTable.heading}>
                      {label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <CollectionTableBody rows={rows}>
              {(action, index) => (
                <CollectionRow key={action.id} onClick={() => selectAction(action)}>
                  <td className={collectionTable.cell}>
                    <span className="text-xs text-foreground-muted">
                      {index + 1}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="max-w-full justify-start px-0"
                      onClick={(event) => {
                        event.stopPropagation()
                        selectAction(action)
                      }}
                    >
                      <ActionIcon type={action.definition.type} size="sm" />
                      <span className="truncate">{action.definition.name}</span>
                    </Button>
                  </td>
                  <td className={collectionTable.cell}>
                    <ActionTypeLabel type={action.definition.type} />
                  </td>
                  <td className={collectionTable.cell}>
                    <span
                      className="block truncate text-foreground-muted"
                      title={action.definition.description}
                    >
                      {action.definition.description || "—"}
                    </span>
                  </td>
                  <td className={collectionTable.cell}>
                    <BuildStatus
                      state={action.definition.enabled ? "active" : "paused"}
                    />
                  </td>
                  <td className={collectionTable.cell}>
                    <span className="text-foreground-muted">
                      v{action.revision}
                    </span>
                  </td>
                </CollectionRow>
              )}
            </CollectionTableBody>
          </CollectionTable>
        ) : state.data !== null && !state.error ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm font-medium">No actions added yet</p>
            <p className="mt-1 text-sm text-foreground-muted">
              Give your agent something new to do with an action.
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-4"
              onClick={() => onViewChange("create")}
            >
              <Plus className="size-3.5" />
              Create action
            </Button>
          </div>
        ) : null}
      </TabsContent>
      <Sheet
        open={Boolean(selected || isCreating)}
        onOpenChange={(open) => {
          if (!open && !pending) clearAction()
        }}
      >
        <SheetContent
          showCloseButton={!pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault()
          }}
        >
          <SheetHeader className="shrink-0 border-b border-border px-6 py-5">
            <div className="flex items-center gap-3 pr-6">
              <ActionIcon type={draft.type} />
              <div className="min-w-0 space-y-1">
                <SheetTitle className="truncate">
                  {selected
                    ? selected.definition.name
                    : draft.name || "New action"}
                </SheetTitle>
                <SheetDescription>
                  {selected
                    ? "Update what this action does and when your agent should use it."
                    : "Set up the action, then save and apply your agent’s changes."}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <form
            onSubmit={(event) => void saveAction(event)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <fieldset
              disabled={pending}
              className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-6"
            >
              {error ? (
                <Notice role="alert" variant="error">
                  {error}
                </Notice>
              ) : null}
              <FormRow
                label="Name"
                htmlFor="action-name"
                layout="vertical"
                variant="plain"
              >
                <Input
                  id="action-name"
                  required
                  value={draft.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </FormRow>
              <FormRow
                label="When should the agent use this?"
                htmlFor="action-description"
                layout="vertical"
                variant="plain"
              >
                <Textarea
                  id="action-description"
                  aria-label="Action description"
                  rows={2}
                  autoSize
                  value={draft.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
              </FormRow>
              <FormRow
                label="Type"
                htmlFor="action-type"
                layout="vertical"
                variant="plain"
              >
                <CustomSelect
                  value={draft.type}
                  onValueChange={(value) => {
                    if (value)
                      setDraft((current) =>
                        withActionType(
                          current,
                          value as ActionDefinition["type"]
                        )
                      )
                  }}
                >
                  <SelectTrigger id="action-type" className="w-full">
                    <SelectValue>
                      <ActionTypeLabel type={draft.type} />
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {(
                      ["http", "client", "widget", "form", "handoff"] as const
                    ).map((type) => (
                      <SelectItem key={type} value={type}>
                        <ActionTypeLabel type={type} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </CustomSelect>
              </FormRow>
              {draft.type === "http" ? (
                <HttpActionFields
                  draft={draft}
                  update={update}
                  editorKey={editorKey}
                />
              ) : null}
              {draft.type === "client" ? (
                <>
                  <FormRow
                    label="Event name"
                    htmlFor="action-event"
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="action-event"
                      required
                      value={draft.eventName}
                      onChange={(event) =>
                        update("eventName", event.target.value)
                      }
                    />
                  </FormRow>
                  <JsonField
                    key={`${editorKey}-${draft.type}-client-result`}
                    label="Result schema"
                    value={draft.resultSchema}
                    onChange={(value) => update("resultSchema", value)}
                    defaultOpen={false}
                  />
                </>
              ) : null}
              {draft.type === "widget" ? (
                <>
                  <FormRow
                    label="Widget ID"
                    htmlFor="action-widget"
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="action-widget"
                      required
                      value={draft.widgetId}
                      onChange={(event) =>
                        update("widgetId", event.target.value)
                      }
                    />
                  </FormRow>
                  <FormRow
                    label="Event name"
                    htmlFor="action-widget-event"
                    layout="vertical"
                    variant="plain"
                  >
                    <Input
                      id="action-widget-event"
                      required
                      value={draft.eventName}
                      onChange={(event) =>
                        update("eventName", event.target.value)
                      }
                    />
                  </FormRow>
                  <JsonField
                    key={`${editorKey}-${draft.type}-widget-result`}
                    label="Result schema"
                    value={draft.resultSchema}
                    onChange={(value) => update("resultSchema", value)}
                    defaultOpen={false}
                  />
                </>
              ) : null}
              {draft.type === "form" ? (
                <FormActionFields draft={draft} update={update} />
              ) : null}
              {draft.type === "handoff" ? (
                <HandoffActionFields draft={draft} update={update} />
              ) : null}
              <InspectorSection
                label="Availability"
                variant="form"
                defaultOpen={false}
              >
                <FormRow label="Enabled" htmlFor="action-enabled">
                  <Switch
                    id="action-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(value) => update("enabled", value)}
                  />
                </FormRow>
                <FormRow label="Procedure only" htmlFor="action-procedure-only">
                  <Switch
                    id="action-procedure-only"
                    checked={draft.procedureOnly}
                    onCheckedChange={(value) => update("procedureOnly", value)}
                  />
                </FormRow>
                <InspectorSection label="Available channels" variant="form">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {supportedChannelOptions.map((item) => (
                      <label
                        key={item}
                        className="flex items-center gap-2 text-sm text-foreground-muted"
                      >
                        <Checkbox
                          checked={draft.channels.includes(item)}
                          onChange={(event) => {
                            const channels = event.currentTarget.checked
                              ? [...new Set([...draft.channels, item])]
                              : draft.channels.filter(
                                  (channel) => channel !== item
                                )
                            update("channels", channels)
                          }}
                        />
                        <span>{channelLabel(item)}</span>
                      </label>
                    ))}
                  </div>
                  {futureChannels.length ? (
                    <p className="mt-2 text-xs text-foreground-muted">
                      Existing {futureChannels.join(", ")} availability is kept
                      in this action while those channels are unavailable here.
                    </p>
                  ) : null}
                </InspectorSection>
              </InspectorSection>
              <JsonField
                key={`${editorKey}-input`}
                label="Input schema"
                value={draft.inputSchema}
                onChange={(value) => update("inputSchema", value)}
                defaultOpen={false}
              />
              <InspectorSection
                label="Advanced identity"
                variant="form"
                defaultOpen={false}
              >
                <FormRow label="Action ID" htmlFor="action-id">
                  <Input
                    id="action-id"
                    required
                    pattern="[a-zA-Z0-9_.-]+"
                    value={draft.id}
                    disabled={!!selected}
                    onChange={(event) => update("id", event.target.value)}
                  />
                </FormRow>
              </InspectorSection>
            </fieldset>
            <SheetFooter className="shrink-0 border-t border-border px-6 py-4">
              {selected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="sm:mr-auto"
                  disabled={pending}
                  onClick={() => void deleteAction(selected)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={clearAction}
              >
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                <Save className="size-4" />
                {selected ? "Save action" : "Create action"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function HttpActionFields({
  draft,
  update,
  editorKey,
}: {
  draft: Extract<ActionDefinition, { type: "http" }>
  update: (key: string, value: unknown) => void
  editorKey: number
}) {
  return (
    <>
      <FormRow
        label="Method"
        htmlFor="action-method"
        layout="vertical"
        variant="plain"
      >
        <Select
          id="action-method"
          value={draft.method}
          onChange={(event) =>
            update("method", event.target.value as typeof draft.method)
          }
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
            <option key={method}>{method}</option>
          ))}
        </Select>
      </FormRow>
      <FormRow
        label="URL"
        htmlFor="action-url"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="action-url"
          required
          type="url"
          value={draft.url}
          onChange={(event) => update("url", event.target.value)}
        />
      </FormRow>
      <InspectorSection label="Headers" variant="form">
        <Textarea
          aria-label="HTTP headers JSON"
          rows={3}
          autoSize
          value={JSON.stringify(draft.headers, null, 2)}
          onChange={(event) => {
            const value = parseJsonObject(event.target.value)
            if (value) update("headers", value)
          }}
        />
      </InspectorSection>
      <InspectorSection label="Body template" variant="form">
        <Textarea
          aria-label="HTTP body template"
          rows={5}
          autoSize
          value={draft.bodyTemplate ?? ""}
          onChange={(event) =>
            update("bodyTemplate", event.target.value || null)
          }
        />
      </InspectorSection>
      <JsonField
        key={`${editorKey}-response`}
        label="Response schema"
        value={draft.responseSchema as Record<string, unknown>}
        onChange={(value) => update("responseSchema", value)}
        defaultOpen={false}
      />
      <FormRow
        label="Timeout (ms)"
        htmlFor="action-timeout"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="action-timeout"
          type="number"
          min={100}
          max={30000}
          value={draft.timeoutMs}
          onChange={(event) => update("timeoutMs", Number(event.target.value))}
        />
      </FormRow>
    </>
  )
}

type FormActionField = Extract<
  ActionDefinition,
  { type: "form" }
>["fields"][number]

function FormActionFields({
  draft,
  update,
}: {
  draft: Extract<ActionDefinition, { type: "form" }>
  update: (key: string, value: unknown) => void
}) {
  function updateField(index: number, patch: Partial<FormActionField>) {
    update(
      "fields",
      draft.fields.map((field, fieldIndex) =>
        fieldIndex === index ? { ...field, ...patch } : field
      )
    )
  }

  function removeField(index: number) {
    update(
      "fields",
      draft.fields.filter((_, fieldIndex) => fieldIndex !== index)
    )
  }

  function addField() {
    const number = draft.fields.length + 1
    update("fields", [
      ...draft.fields,
      {
        name: `field_${number}`,
        label: `Field ${number}`,
        type: "text",
        required: false,
        options: [],
      },
    ])
  }

  return (
    <>
      <FormRow label="Save as lead" layout="vertical" variant="plain">
        <Switch
          aria-label="Save as lead"
          checked={draft.captureLead}
          onCheckedChange={(checked) => update("captureLead", checked)}
        />
      </FormRow>
      <FormRow
        label="Submit label"
        htmlFor="action-submit-label"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="action-submit-label"
          value={draft.submitLabel}
          onChange={(event) => update("submitLabel", event.target.value)}
        />
      </FormRow>
      <InspectorSection
        label={`Form fields (${draft.fields.length})`}
        variant="form"
        defaultOpen
      >
        <div className="space-y-3">
          {draft.fields.map((field, index) => (
            <div
              key={index}
              className="rounded-md border border-border bg-background p-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-foreground-muted">
                  Field {index + 1}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove form field ${index + 1}`}
                  onClick={() => removeField(index)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <FormRow
                  label="Field name"
                  layout="vertical"
                  variant="plain"
                  htmlFor={`action-field-name-${index}`}
                >
                  <Input
                    id={`action-field-name-${index}`}
                    aria-label={`Field ${index + 1} name`}
                    required
                    value={field.name}
                    onChange={(event) =>
                      updateField(index, { name: event.target.value })
                    }
                  />
                </FormRow>
                <FormRow
                  label="Customer label"
                  layout="vertical"
                  variant="plain"
                  htmlFor={`action-field-label-${index}`}
                >
                  <Input
                    id={`action-field-label-${index}`}
                    aria-label={`Field ${index + 1} label`}
                    required
                    value={field.label}
                    onChange={(event) =>
                      updateField(index, { label: event.target.value })
                    }
                  />
                </FormRow>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <FormRow
                  label="Response type"
                  layout="vertical"
                  variant="plain"
                  htmlFor={`action-field-type-${index}`}
                >
                  <Select
                    id={`action-field-type-${index}`}
                    aria-label={`Field ${index + 1} type`}
                    value={field.type}
                    onChange={(event) =>
                      updateField(index, {
                        type: event.target.value as FormActionField["type"],
                      })
                    }
                  >
                    <option value="text">Short text</option>
                    <option value="textarea">Long text</option>
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="number">Number</option>
                    <option value="select">Select</option>
                  </Select>
                </FormRow>
                <FormRow
                  label="Required"
                  htmlFor={`action-field-required-${index}`}
                  layout="vertical"
                  variant="plain"
                >
                  <Switch
                    id={`action-field-required-${index}`}
                    aria-label={`Field ${index + 1} required`}
                    checked={field.required}
                    onCheckedChange={(value) =>
                      updateField(index, { required: value })
                    }
                  />
                </FormRow>
              </div>
              {field.type === "select" ? (
                <InspectorSection label="Select options" variant="form">
                  <Textarea
                    aria-label={`Field ${index + 1} options`}
                    rows={3}
                    autoSize
                    placeholder="One option per line"
                    value={field.options.join("\n")}
                    onChange={(event) =>
                      updateField(index, {
                        options: event.target.value
                          .split("\n")
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </InspectorSection>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.fields.length >= 100}
            onClick={addField}
          >
            <Plus className="size-3.5" />
            Add form field
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection
        label="Advanced schema editor"
        variant="form"
        defaultOpen={false}
      >
        <Textarea
          aria-label="Form fields JSON"
          rows={7}
          autoSize
          spellCheck={false}
          value={JSON.stringify(draft.fields, null, 2)}
          onChange={(event) => {
            const value = parseJsonArray(event.target.value)
            if (value)
              update(
                "fields",
                value as Extract<ActionDefinition, { type: "form" }>["fields"]
              )
          }}
        />
        <p className="mt-1 text-xs text-foreground-muted">
          Use this for field options or schemas that need a custom shape.
        </p>
      </InspectorSection>
      <FormRow
        label="Submit action ID"
        htmlFor="action-submit-id"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="action-submit-id"
          value={draft.submitActionId ?? ""}
          onChange={(event) =>
            update("submitActionId", event.target.value || null)
          }
        />
      </FormRow>
    </>
  )
}

function HandoffActionFields({
  draft,
  update,
}: {
  draft: Extract<ActionDefinition, { type: "handoff" }>
  update: (key: string, value: unknown) => void
}) {
  return (
    <>
      <FormRow
        label="Team ID"
        htmlFor="action-team"
        layout="vertical"
        variant="plain"
      >
        <Input
          id="action-team"
          value={draft.teamId ?? ""}
          onChange={(event) => update("teamId", event.target.value || null)}
        />
      </FormRow>
      <FormRow
        label="Priority"
        htmlFor="action-priority"
        layout="vertical"
        variant="plain"
      >
        <Select
          id="action-priority"
          value={draft.priority}
          onChange={(event) =>
            update("priority", event.target.value as typeof draft.priority)
          }
        >
          {["low", "normal", "high", "urgent"].map((priority) => (
            <option key={priority}>{priority}</option>
          ))}
        </Select>
      </FormRow>
      <InspectorSection label="Handoff message" variant="form">
        <Textarea
          aria-label="Handoff message"
          rows={3}
          autoSize
          value={draft.message}
          onChange={(event) => update("message", event.target.value)}
        />
      </InspectorSection>
    </>
  )
}

function JsonField({
  label,
  value,
  onChange,
  defaultOpen = true,
}: {
  label: string
  value: object
  onChange: (value: Record<string, unknown>) => void
  defaultOpen?: boolean
}) {
  const [text, setText] = React.useState(() => JSON.stringify(value, null, 2))
  return (
    <InspectorSection
      label={`${label} (JSON)`}
      variant="form"
      defaultOpen={defaultOpen}
    >
      <Textarea
        aria-label={label}
        rows={5}
        autoSize
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          const next = parseJsonObject(event.target.value)
          if (next) onChange(next)
        }}
      />
      <p className="mt-1 text-xs text-foreground-muted">
        Use a JSON Schema object. Invalid drafts stay visible until corrected.
      </p>
    </InspectorSection>
  )
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const emptyProcedure: ProcedureDefinition = {
  name: "",
  description: "",
  enabled: true,
  trigger: { type: "keyword", value: "" },
  variables: {},
  steps: [{ id: `step-${Date.now()}`, kind: "message", content: "" }],
  branches: [],
  actionRefs: [],
}

function ProceduresTab({
  agentId,
  onDefinitionDirty,
}: {
  agentId: string
  onDefinitionDirty?: () => void
}) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      buildCall<unknown>(
        buildOperations.listProcedures,
        { agentId },
        { signal }
      ).then((value) => listItems<ProcedureRecord>(value)),
    [agentId]
  )
  const state = useRemote(load, [agentId])
  const [selected, setSelected] = React.useState<ProcedureRecord | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [draft, setDraft] = React.useState<ProcedureDefinition>(emptyProcedure)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const rows = state.data ?? []
  const update = <K extends keyof ProcedureDefinition>(
    key: K,
    value: ProcedureDefinition[K]
  ) => setDraft((current) => ({ ...current, [key]: value }))
  function beginProcedure() {
    setSelected(null)
    setIsCreating(true)
    setDraft({
      ...emptyProcedure,
      steps: [{ id: `step-${Date.now()}`, kind: "message", content: "" }],
    })
    setError(null)
    setMessage(null)
  }
  function selectProcedure(procedure: ProcedureRecord) {
    setSelected(procedure)
    setIsCreating(false)
    setDraft(procedure.definition)
    setError(null)
    setMessage(null)
  }
  function clearProcedure() {
    setSelected(null)
    setIsCreating(false)
    setError(null)
    setMessage(null)
  }
  async function saveProcedure(event: React.FormEvent) {
    event.preventDefault()
    if (
      pending ||
      !draft.name.trim() ||
      !draft.trigger.value.trim() ||
      !draft.steps.length
    )
      return
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const savedProcedure = await buildCall<ProcedureRecord>(
        selected
          ? buildOperations.updateProcedure
          : buildOperations.createProcedure,
        {
          agentId,
          id: selected?.id ?? `procedure-${Date.now()}`,
          slug: draft.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
          definition: draft,
          ...(selected ? { expectedRevision: selected.revision } : {}),
        }
      )
      onDefinitionDirty?.()
      setSelected(savedProcedure)
      setIsCreating(false)
      setDraft(savedProcedure.definition)
      setMessage(selected ? "Procedure updated." : "Procedure created.")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  async function deleteProcedure(procedure: ProcedureRecord) {
    if (!window.confirm(`Delete ${procedure.definition.name}?`)) return
    try {
      await buildCall(buildOperations.deleteProcedure, {
        agentId,
        procedureId: procedure.id,
        expectedRevision: procedure.revision,
      })
      onDefinitionDirty?.()
      if (selected?.id === procedure.id) clearProcedure()
      setMessage("Procedure deleted.")
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    }
  }
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <h2 className="text-base font-semibold">Procedures</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Turn a repeatable customer task into a short, testable sequence of
          messages, actions and handoffs.
        </p>
      </div>
      {error ? (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      ) : null}
      {message ? (
        <Notice role="status" variant="success">
          {message}
        </Notice>
      ) : null}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(15rem,0.34fr)_minmax(0,0.66fr)]">
        <section aria-label="Procedures">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Configured procedures</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={beginProcedure}
            >
              <Plus className="size-3.5" />
              New
            </Button>
          </div>
          {state.error ? (
            <BuildErrorState
              message={state.error.message}
              onRetry={state.refresh}
            />
          ) : state.data === null ? (
            <LoadingState compact label="Loading procedures" />
          ) : rows.length ? (
            <div className="divide-y divide-border rounded-md border border-border">
              {rows.map((procedure) => (
                <button
                  type="button"
                  key={procedure.id}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-3 text-left text-sm outline-none hover:bg-surface-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${selected?.id === procedure.id ? "bg-selection text-selection-foreground" : ""}`}
                  onClick={() => selectProcedure(procedure)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {procedure.definition.name}
                    </span>
                    <span className="mt-1 block text-xs text-foreground-muted">
                      {procedure.definition.trigger.type} ·{" "}
                      {procedure.definition.steps.length} steps
                    </span>
                  </span>
                  <BuildStatus
                    state={procedure.definition.enabled ? "active" : "paused"}
                  />
                </button>
              ))}
            </div>
          ) : (
            <Notice variant="info">No procedures yet.</Notice>
          )}
        </section>
        {selected || isCreating ? (
          <form
            onSubmit={(event) => void saveProcedure(event)}
            className="min-w-0 rounded-xl border border-border bg-muted p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">
                  {selected
                    ? `Edit ${selected.definition.name}`
                    : "New procedure"}
                </h3>
                <p className="text-xs text-foreground-muted">
                  Start with the trigger and steps. Optional variables and
                  branches stay available below.
                </p>
              </div>
              {selected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear selected procedure"
                  onClick={clearProcedure}
                >
                  ×
                </Button>
              ) : null}
            </div>
            <fieldset disabled={pending} className="space-y-1">
              <FormRow label="Name" htmlFor="procedure-name">
                <Input
                  id="procedure-name"
                  required
                  value={draft.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </FormRow>
              <InspectorSection label="Description" variant="form">
                <Textarea
                  aria-label="Procedure description"
                  rows={2}
                  autoSize
                  value={draft.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
              </InspectorSection>
              <FormRow label="Enabled" htmlFor="procedure-enabled">
                <Switch
                  id="procedure-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(value) => update("enabled", value)}
                />
              </FormRow>
              <FormRow label="Trigger" htmlFor="procedure-trigger-type">
                <Select
                  id="procedure-trigger-type"
                  value={draft.trigger.type}
                  onChange={(event) =>
                    update("trigger", {
                      ...draft.trigger,
                      type: event.target.value as typeof draft.trigger.type,
                    })
                  }
                >
                  <option value="keyword">A keyword is mentioned</option>
                  <option value="intent">An intent is detected</option>
                  <option value="event">An event arrives</option>
                  <option value="manual">Run manually</option>
                </Select>
              </FormRow>
              <FormRow label="Trigger value" htmlFor="procedure-trigger-value">
                <Input
                  id="procedure-trigger-value"
                  required
                  value={draft.trigger.value}
                  onChange={(event) =>
                    update("trigger", {
                      ...draft.trigger,
                      value: event.target.value,
                    })
                  }
                />
              </FormRow>
              <ProcedureSteps
                steps={draft.steps}
                onChange={(steps) => update("steps", steps)}
              />
              <InspectorSection
                label="Variables (JSON)"
                variant="form"
                defaultOpen={false}
              >
                <Textarea
                  aria-label="Procedure variables JSON"
                  rows={4}
                  autoSize
                  spellCheck={false}
                  value={JSON.stringify(draft.variables, null, 2)}
                  onChange={(event) => {
                    const value = parseJsonObject(event.target.value)
                    if (value)
                      update(
                        "variables",
                        value as ProcedureDefinition["variables"]
                      )
                  }}
                />
              </InspectorSection>
              <InspectorSection
                label="Branches (JSON)"
                variant="form"
                defaultOpen={false}
              >
                <Textarea
                  aria-label="Procedure branches JSON"
                  rows={5}
                  autoSize
                  spellCheck={false}
                  value={JSON.stringify(draft.branches, null, 2)}
                  onChange={(event) => {
                    const value = parseJsonArray(event.target.value)
                    if (value)
                      update(
                        "branches",
                        value as ProcedureDefinition["branches"]
                      )
                  }}
                />
              </InspectorSection>
              <InspectorSection
                label="Action references (JSON)"
                variant="form"
                defaultOpen={false}
              >
                <Textarea
                  aria-label="Procedure action references JSON"
                  rows={3}
                  autoSize
                  spellCheck={false}
                  value={JSON.stringify(draft.actionRefs, null, 2)}
                  onChange={(event) => {
                    const value = parseJsonArray(event.target.value)
                    if (value)
                      update(
                        "actionRefs",
                        value.filter(
                          (item): item is string => typeof item === "string"
                        )
                      )
                  }}
                />
              </InspectorSection>
            </fieldset>
            <div className="mt-4 flex justify-end gap-2">
              {selected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void deleteProcedure(selected)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              ) : null}
              <Button type="submit" size="sm" loading={pending}>
                <Save className="size-3.5" />
                {selected ? "Save procedure" : "Create procedure"}
              </Button>
            </div>
          </form>
        ) : (
          <ResourceEditorPrompt
            resource="procedure"
            description="Select a procedure to review it, or create a repeatable workflow for the agent."
            actionLabel="New procedure"
            onCreate={beginProcedure}
          />
        )}
      </div>
    </div>
  )
}

function ProcedureSteps({
  steps,
  onChange,
}: {
  steps: ProcedureDefinition["steps"]
  onChange: (steps: ProcedureDefinition["steps"]) => void
}) {
  return (
    <InspectorSection
      label={`Steps (${steps.length}/15)`}
      icon={<ChevronDown className="size-3.5" />}
    >
      <div className="space-y-2">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className="rounded-md border border-border bg-background p-2"
          >
            <div className="flex items-center gap-2">
              <span className="w-6 text-center text-xs text-foreground-muted">
                {index + 1}
              </span>
              <Select
                aria-label={`Step ${index + 1} type`}
                value={step.kind}
                onChange={(event) => {
                  const kind = event.target
                    .value as ProcedureDefinition["steps"][number]["kind"]
                  const next = [...steps]
                  next[index] =
                    kind === "message"
                      ? { id: step.id, kind, content: "" }
                      : kind === "action"
                        ? { id: step.id, kind, actionId: "", input: {} }
                        : kind === "set_variable"
                          ? { id: step.id, kind, name: "", value: "" }
                          : kind === "wait"
                            ? { id: step.id, kind, seconds: 1 }
                            : { id: step.id, kind, actionId: "" }
                  onChange(next)
                }}
              >
                <option value="message">Message</option>
                <option value="action">Action</option>
                <option value="set_variable">Set variable</option>
                <option value="wait">Wait</option>
                <option value="handoff">Handoff</option>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove step ${index + 1}`}
                onClick={() =>
                  onChange(steps.filter((_, position) => position !== index))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="mt-2 pl-8">
              {step.kind === "message" ? (
                <Textarea
                  aria-label={`Step ${index + 1} message`}
                  rows={2}
                  autoSize
                  required
                  value={step.content}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = { ...step, content: event.target.value }
                    onChange(next)
                  }}
                />
              ) : null}
              {step.kind === "action" || step.kind === "handoff" ? (
                <Input
                  aria-label={`Step ${index + 1} action ID`}
                  placeholder="action-id"
                  required
                  value={step.actionId}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = { ...step, actionId: event.target.value }
                    onChange(next)
                  }}
                />
              ) : null}
              {step.kind === "set_variable" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label={`Step ${index + 1} variable name`}
                    placeholder="variable"
                    required
                    value={step.name}
                    onChange={(event) => {
                      const next = [...steps]
                      next[index] = { ...step, name: event.target.value }
                      onChange(next)
                    }}
                  />
                  <Input
                    aria-label={`Step ${index + 1} value`}
                    value={String(step.value)}
                    onChange={(event) => {
                      const next = [...steps]
                      next[index] = { ...step, value: event.target.value }
                      onChange(next)
                    }}
                  />
                </div>
              ) : null}
              {step.kind === "wait" ? (
                <Input
                  aria-label={`Step ${index + 1} wait seconds`}
                  type="number"
                  min={0}
                  max={86400}
                  value={step.seconds}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = {
                      ...step,
                      seconds: Number(event.target.value),
                    }
                    onChange(next)
                  }}
                />
              ) : null}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={steps.length >= 15}
          onClick={() =>
            onChange([
              ...steps,
              { id: `step-${Date.now()}`, kind: "message", content: "" },
            ])
          }
        >
          <Plus className="size-3.5" />
          Add step
        </Button>
      </div>
    </InspectorSection>
  )
}

type ChannelConnectionView = {
  id: string
  channel: BuildChannel
  label: string
  status: "draft" | "connected" | "paused" | "error" | "disconnected"
  externalId: string | null
  lastError: string | null
}
