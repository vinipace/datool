"use client"

import * as React from "react"
import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  FlaskConical,
  ListChecks,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { buildApi, asList, asRecord } from "./build-api"
import {
  BuildEmpty,
  BuildFrame,
  BuildState,
  BuildStatus,
  BuildToolbar,
  FormLabel,
} from "./build-page"

type Agent = {
  id: string
  name?: string
  slug?: string
  appliedRevision?: number
}
type Simulation = {
  id: string
  agentId?: string
  name?: string
  description?: string
  channel?: string
  persona?: {
    name?: string
    traits?: string[]
    goals?: string[]
    context?: string
  }
  scenario?: string
  initialMessage?: string
  successCriteria?: string[]
  expectedActions?: unknown[]
  maxTurns?: number
  repeats?: number
  models?: string[]
  revision?: number
  status?: string
  updatedAt?: string
}
type Run = {
  id: string
  definitionId?: string
  status?: string
  requestedCases?: number
  completedCases?: number
  passedCases?: number
  failedCases?: number
  noVerdictCases?: number
  infraErrorCases?: number
  createdAt?: string
  completedAt?: string | null
  error?: string | null
}
type Case = {
  id: string
  ordinal?: number
  repeatIndex?: number
  variantKey?: string
  model?: string
  status?: string
  transcript?: Array<{ role?: string; content?: string }>
  observedActions?: unknown[]
  verdict?: { status?: string; score?: number | null; reason?: string } | null
  error?: string | null
}
type SimulationForm = {
  name: string
  description: string
  channel: string
  personaName: string
  personaTraits: string
  personaGoals: string
  personaContext: string
  scenario: string
  initialMessage: string
  criteria: string
  expectedActions: string
  maxTurns: string
  repeats: string
  models: string
}

const initialSimulationForm: SimulationForm = {
  name: "",
  description: "",
  channel: "web",
  personaName: "Customer",
  personaTraits: "",
  personaGoals: "",
  personaContext: "",
  scenario: "",
  initialMessage: "",
  criteria: "",
  expectedActions: "",
  maxTurns: "20",
  repeats: "1",
  models: "default",
}

function formFromSimulation(test: Simulation): SimulationForm {
  return {
    name: test.name ?? "",
    description: test.description ?? "",
    channel: test.channel ?? "web",
    personaName: test.persona?.name ?? "Customer",
    personaTraits: test.persona?.traits?.join("\n") ?? "",
    personaGoals: test.persona?.goals?.join("\n") ?? "",
    personaContext: test.persona?.context ?? "",
    scenario: test.scenario ?? "",
    initialMessage: test.initialMessage ?? "",
    criteria: test.successCriteria?.join("\n") ?? "",
    expectedActions: test.expectedActions?.length
      ? JSON.stringify(test.expectedActions, null, 2)
      : "",
    maxTurns: String(test.maxTurns ?? 20),
    repeats: String(test.repeats ?? 1),
    models: test.models?.join(", ") || "default",
  }
}

function parseSimulationForm(form: SimulationForm) {
  const successCriteria = form.criteria
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!successCriteria.length)
    throw new Error("Add at least one success criterion.")
  let expectedActions: unknown[] = []
  try {
    expectedActions = form.expectedActions.trim()
      ? JSON.parse(form.expectedActions)
      : []
  } catch {
    throw new Error("Expected actions must be valid JSON.")
  }
  if (!Array.isArray(expectedActions))
    throw new Error("Expected actions must be a JSON array.")
  const models = form.models
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  if (!models.length) throw new Error("Add at least one model.")
  return {
    name: form.name,
    description: form.description,
    channel: form.channel,
    persona: {
      name: form.personaName || "Customer",
      traits: form.personaTraits
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      goals: form.personaGoals
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      context: form.personaContext,
    },
    scenario: form.scenario,
    initialMessage: form.initialMessage,
    successCriteria,
    expectedActions,
    maxTurns: Number(form.maxTurns),
    repeats: Number(form.repeats),
    models,
  }
}

function items<T>(value: unknown) {
  const record = asRecord(value)
  return asList<T>(record.items ?? value)
}

function formatWhen(value?: string | null) {
  if (!value) return "No date"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "No date" : date.toLocaleString()
}

function SimulationFields({
  form,
  setForm,
}: {
  form: SimulationForm
  setForm: React.Dispatch<React.SetStateAction<SimulationForm>>
}) {
  const update =
    (key: keyof SimulationForm) =>
    (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >
    ) =>
      setForm((current) => ({ ...current, [key]: event.target.value }))
  const modelNames = form.models
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  const modelSummary =
    modelNames.length > 1
      ? `${modelNames[0]} +${modelNames.length - 1}`
      : modelNames[0] || "default"
  const channelSummary =
    form.channel === "web"
      ? "Website"
      : form.channel === "api"
        ? "API"
        : "Telegram"
  return (
    <>
      <FormLabel label="Name">
        <Input
          value={form.name}
          onChange={update("name")}
          placeholder="Returns flow"
          required
        />
      </FormLabel>
      <FormLabel label="Scenario">
        <Textarea
          rows={5}
          value={form.scenario}
          onChange={update("scenario")}
          placeholder="The customer needs to return an order and asks about the refund timeline…"
          required
        />
      </FormLabel>
      <FormLabel
        label="Initial customer message"
        hint="What the simulated customer says first"
      >
        <Textarea
          rows={4}
          value={form.initialMessage}
          onChange={update("initialMessage")}
          placeholder="I need help with an order"
          required
        />
      </FormLabel>
      <FormLabel label="Success criteria" hint="One criterion per line">
        <Textarea
          rows={5}
          value={form.criteria}
          onChange={update("criteria")}
          placeholder="Agent confirms the return policy"
          required
        />
      </FormLabel>
      <details className="group rounded-lg border border-border bg-muted">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span>Advanced context</span>
          <span className="flex items-center gap-2 text-xs font-normal text-foreground-muted">
            <span>
              {channelSummary} · {form.personaName || "Customer"}
            </span>
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="space-y-4 border-t border-border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormLabel label="Channel">
              <Select value={form.channel} onChange={update("channel")}>
                <option value="telegram">Telegram</option>
                <option value="web">Website</option>
                <option value="api">API</option>
              </Select>
            </FormLabel>
            <FormLabel label="Persona name">
              <Input
                value={form.personaName}
                onChange={update("personaName")}
              />
            </FormLabel>
          </div>
          <FormLabel label="Description" hint="Optional context for reviewers">
            <Textarea
              rows={2}
              value={form.description}
              onChange={update("description")}
            />
          </FormLabel>
          <div className="grid gap-4 md:grid-cols-3">
            <FormLabel label="Persona traits" hint="One per line">
              <Textarea
                rows={4}
                value={form.personaTraits}
                onChange={update("personaTraits")}
              />
            </FormLabel>
            <FormLabel label="Persona goals" hint="One per line">
              <Textarea
                rows={4}
                value={form.personaGoals}
                onChange={update("personaGoals")}
              />
            </FormLabel>
            <FormLabel label="Persona context">
              <Textarea
                rows={4}
                value={form.personaContext}
                onChange={update("personaContext")}
              />
            </FormLabel>
          </div>
        </div>
      </details>
      <details className="group rounded-lg border border-border bg-muted">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span>Run settings</span>
          <span className="flex items-center gap-2 text-xs font-normal text-foreground-muted">
            <span>
              {form.maxTurns || "20"} turns · {form.repeats || "1"} repeat
              {form.repeats === "1" ? "" : "s"} · {modelSummary}
            </span>
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="space-y-4 border-t border-border p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormLabel label="Max turns" hint="1–200">
              <Input
                type="number"
                min={1}
                max={200}
                value={form.maxTurns}
                onChange={update("maxTurns")}
              />
            </FormLabel>
            <FormLabel label="Repeats" hint="1–100">
              <Input
                type="number"
                min={1}
                max={100}
                value={form.repeats}
                onChange={update("repeats")}
              />
            </FormLabel>
            <FormLabel label="Model override" hint="Comma separated">
              <Input value={form.models} onChange={update("models")} />
            </FormLabel>
          </div>
          <FormLabel label="Expected actions" hint="JSON array">
            <Textarea
              rows={4}
              value={form.expectedActions}
              onChange={update("expectedActions")}
              placeholder="[]"
            />
          </FormLabel>
        </div>
      </details>
    </>
  )
}

export function TestsPage() {
  const workspaceHref = useWorkspaceHref()
  const [agentId, setAgentId] = React.useState<string | null>(null)
  const [showCreate, setShowCreate] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState("")
  const agents = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_agents", { includeArchived: false }, signal)
        .then(items<Agent>),
    []
  )
  const activeAgentId = agentId === null ? agents.data?.[0]?.id || "" : agentId
  const tests = useRemote(
    (signal) =>
      activeAgentId
        ? buildApi
            .call<unknown>(
              "build_list_simulations",
              { agentId: activeAgentId },
              signal
            )
            .then(items<Simulation>)
        : Promise.resolve([]),
    [activeAgentId],
    { enabled: !!activeAgentId }
  )
  const runs = useRemote(
    (signal) =>
      selectedId
        ? buildApi
            .call<unknown>(
              "build_list_simulation_runs",
              { definitionId: selectedId },
              signal
            )
            .then(items<Run>)
        : Promise.resolve([]),
    [selectedId],
    { enabled: !!selectedId, intervalMs: 5_000 }
  )
  const create = useMutation()
  const update = useMutation()
  const run = useMutation()
  const [form, setForm] = React.useState<SimulationForm>(initialSimulationForm)
  const [showEdit, setShowEdit] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const visibleTests = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tests.data ?? []
    return (tests.data ?? []).filter((test) =>
      `${test.name ?? ""} ${test.description ?? ""} ${test.channel ?? ""}`
        .toLowerCase()
        .includes(query)
    )
  }, [search, tests.data])

  function openCreate() {
    setForm(initialSimulationForm)
    setFormError(null)
    setShowEdit(false)
    setShowCreate(true)
  }

  function openEdit(test: Simulation) {
    setSelectedId(test.id)
    setForm(formFromSimulation(test))
    setFormError(null)
    setShowCreate(false)
    setShowEdit(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!activeAgentId) return
    try {
      setFormError(null)
      const definition = parseSimulationForm(form)
      await create.run(() =>
        buildApi.call("build_create_simulation", {
          agentId: activeAgentId,
          definition,
        })
      )
      setShowCreate(false)
      setForm(initialSimulationForm)
      tests.refresh()
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "The simulation could not be saved."
      )
    }
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault()
    const selectedTest = tests.data?.find((test) => test.id === selectedId)
    if (!activeAgentId || !selectedTest) return
    try {
      setFormError(null)
      const definition = parseSimulationForm(form)
      await update.run(() =>
        buildApi.call("build_update_simulation", {
          agentId: activeAgentId,
          definitionId: selectedTest.id,
          expectedRevision: selectedTest.revision ?? 1,
          definition,
        })
      )
      setShowEdit(false)
      tests.refresh()
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "The simulation could not be updated."
      )
    }
  }

  async function start(test: Simulation) {
    setSelectedId(test.id)
    try {
      await run.run(() =>
        buildApi.call("build_start_simulation", {
          agentId: activeAgentId,
          definitionId: test.id,
          repeats: test.repeats,
          models: test.models,
        })
      )
      runs.refresh()
    } catch {
      // The mutation error remains visible below the test list.
    }
  }

  const selectedTest =
    tests.data?.find((test) => test.id === selectedId) ?? null
  const dialogOpen = showCreate || showEdit

  return (
    <BuildFrame
      title="Tests"
      description="Check how your agent handles customer scenarios before applying a change."
      breadcrumbs={[
        { label: "Build", href: workspaceHref("/build/agents") },
        { label: "Tests", href: workspaceHref("/build/tests") },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <Select
            aria-label="Test agent"
            value={activeAgentId}
            onChange={(event) => {
              setAgentId(event.target.value)
              setSelectedId(null)
              setShowEdit(false)
            }}
            className="h-8 w-auto max-w-48 text-xs"
          >
            <option value="">Select agent…</option>
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name || agent.slug || agent.id}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={openCreate} disabled={!activeAgentId}>
            <Plus className="size-3.5" /> New test
          </Button>
        </div>
      }
    >
      {agents.error ? (
        <Notice variant="error">{agents.error.message}</Notice>
      ) : null}
      <div className="space-y-5">
        <BuildToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Search tests…"
        >
          <span className="hidden text-xs text-foreground-muted sm:inline">
            {visibleTests.length} {visibleTests.length === 1 ? "test" : "tests"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              tests.refresh()
              runs.refresh()
            }}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </BuildToolbar>

        <BuildState
          isLoading={agents.isLoading || (!!activeAgentId && tests.isLoading)}
          error={agents.error ?? tests.error}
          onRetry={() => {
            agents.refresh()
            tests.refresh()
          }}
        >
          {!activeAgentId ? (
            <BuildEmpty
              title="Select an agent"
              description="Create or select a managed Build agent before defining simulations."
            />
          ) : visibleTests.length ? (
            <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
              <div className="grid content-start gap-3 md:grid-cols-2 xl:grid-cols-1">
                {visibleTests.map((test) => (
                  <SimulationCard
                    key={test.id}
                    test={test}
                    selected={test.id === selectedId}
                    busy={run.isPending && selectedId === test.id}
                    onSelect={() => setSelectedId(test.id)}
                    onEdit={() => openEdit(test)}
                    onRun={() => void start(test)}
                  />
                ))}
              </div>
              <TestRunInspector
                hasSelectedTest={Boolean(selectedTest)}
                runs={runs.data ?? []}
                loading={runs.isLoading}
                error={runs.error}
              />
            </div>
          ) : (
            <Card>
              <BuildEmpty
                title={search ? "No matching tests" : "No simulations yet"}
                description={
                  search
                    ? "Try another name or clear the search."
                    : "Create a customer scenario with expected outcomes, then run it against the selected agent."
                }
                action={
                  search ? (
                    <Button variant="outline" onClick={() => setSearch("")}>
                      <Search className="size-3.5" /> Clear search
                    </Button>
                  ) : (
                    <Button onClick={openCreate}>
                      <Plus className="size-3.5" /> Create test
                    </Button>
                  )
                }
              />
            </Card>
          )}
        </BuildState>
        {run.error ? (
          <Notice variant="error">{run.error.message}</Notice>
        ) : null}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open || (!create.isPending && !update.isPending)) {
            setShowCreate(open && !showEdit)
            setShowEdit(open && showEdit)
          }
        }}
      >
        <DialogContent className="flex max-h-[92dvh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {showEdit && selectedTest
                ? `Edit ${selectedTest.name || "simulation"}`
                : "Create test"}
            </DialogTitle>
            <DialogDescription>
              {showEdit && selectedTest
                ? `Editing version ${selectedTest.revision ?? 1}. Previous runs keep their original test settings.`
                : "Define the customer, context and outcomes that make this test useful."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col gap-4"
            onSubmit={(event) =>
              void (showEdit ? saveEdit(event) : submit(event))
            }
          >
            <div className="min-h-0 space-y-4 overflow-y-auto px-1">
              <SimulationFields form={form} setForm={setForm} />
              {formError || (showEdit ? update.error : create.error) ? (
                <Notice role="alert" variant="error">
                  {formError || (showEdit ? update.error?.message : create.error?.message)}
                </Notice>
              ) : null}
            </div>
            <DialogFooter className="border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending || update.isPending}
                onClick={() => {
                  setShowCreate(false)
                  setShowEdit(false)
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={showEdit ? update.isPending : create.isPending}
              >
                {showEdit ? "Save revision" : "Create test"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BuildFrame>
  )
}

function SimulationCard({
  test,
  selected,
  busy,
  onSelect,
  onEdit,
  onRun,
}: {
  test: Simulation
  selected: boolean
  busy: boolean
  onSelect: () => void
  onEdit: () => void
  onRun: () => void
}) {
  return (
    <Card className={selected ? "border-ring" : undefined}>
      <CardHeader className="flex items-start gap-3 pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background text-foreground-muted">
          <FlaskConical className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle className="truncate text-sm">
              {test.name || "Untitled simulation"}
            </CardTitle>
            <BuildStatus status={test.status} />
          </div>
          <CardDescription className="mt-1 line-clamp-2">
            {test.description || "No description"}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs">
          <div>
            <p className="text-foreground-muted">Channel</p>
            <p className="mt-1 font-medium capitalize">{test.channel || "—"}</p>
          </div>
          <div>
            <p className="text-foreground-muted">Revision</p>
            <p className="mt-1 font-medium tabular-nums">
              {test.revision ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-foreground-muted">Turns</p>
            <p className="mt-1 font-medium tabular-nums">
              {test.maxTurns ?? "—"}
            </p>
          </div>
        </div>
        <p className="text-xs text-foreground-muted">
          Updated {formatWhen(test.updatedAt)}
        </p>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant={selected ? "secondary" : "outline"}
            onClick={onSelect}
          >
            <ListChecks className="size-3.5" />{" "}
            {selected ? "Viewing runs" : "View runs"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Edit ${test.name || "simulation"}`}
            title="Edit test"
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button size="sm" variant="outline" loading={busy} onClick={onRun}>
            <Play className="size-3.5" /> Run
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function TestRunInspector({
  hasSelectedTest,
  runs,
  loading,
  error,
}: {
  hasSelectedTest: boolean
  runs: Run[]
  loading: boolean
  error: Error | null
}) {
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const selected = runs.find((run) => run.id === selectedRunId) ?? runs[0]
  const cases = useRemote(
    (signal) =>
      selected?.id
        ? buildApi
            .call<unknown>(
              "build_list_simulation_cases",
              { runId: selected.id },
              signal
            )
            .then(items<Case>)
        : Promise.resolve([]),
    [selected?.id],
    { enabled: !!selected?.id, intervalMs: 5_000 }
  )

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          {hasSelectedTest
            ? "Select a run to inspect its cases and transcript."
            : "Choose a test to see run history."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-foreground-muted">Loading runs…</p>
        ) : null}
        {!loading && error ? (
          <Notice variant="error">{error.message}</Notice>
        ) : null}
        {!hasSelectedTest ? (
          <p className="text-sm text-foreground-muted">
            Select a test to view its runs.
          </p>
        ) : null}
        {hasSelectedTest && !loading && !error && !runs.length ? (
          <BuildEmpty
            title="No runs yet"
            description="Run this test to see the conversation and whether it met your success criteria."
          />
        ) : null}
        {!loading && !error && runs.length ? (
          <>
            <div className="space-y-2" role="list" aria-label="Simulation runs">
              {runs.map((run, index) => (
                <button
                  type="button"
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full rounded-lg border border-border p-3 text-left transition-colors outline-none hover:bg-surface-row-hover focus-visible:ring-2 focus-visible:ring-ring ${run.id === selected?.id ? "bg-selection/30" : "bg-background"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Run {index + 1}</span>
                    <BuildStatus status={run.status} />
                  </div>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {formatWhen(run.createdAt)}
                    {run.completedAt
                      ? ` · completed ${formatWhen(run.completedAt)}`
                      : ""}
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-foreground-muted">
                    <span>Passed {run.passedCases ?? 0}</span>
                    <span>Failed {run.failedCases ?? 0}</span>
                    <span>
                      {run.completedCases ?? 0}/{run.requestedCases ?? 0} cases
                    </span>
                  </div>
                  {run.error ? (
                    <p className="mt-2 text-xs text-destructive">{run.error}</p>
                  ) : null}
                </button>
              ))}
            </div>
            {selected ? (
              <div className="border-t border-border pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground-muted">
                    Cases in Run{" "}
                    {runs.findIndex((run) => run.id === selected.id) + 1}
                  </p>
                  <span className="text-xs text-foreground-muted">
                    {selected.infraErrorCases ?? 0} infrastructure errors
                  </span>
                </div>
                {cases.isLoading ? (
                  <p className="mt-2 text-xs text-foreground-muted">
                    Loading cases…
                  </p>
                ) : null}
                {!cases.isLoading && cases.error ? (
                  <Notice className="mt-2" variant="error">
                    {cases.error.message}
                  </Notice>
                ) : null}
                {!cases.isLoading && !cases.error && !cases.data?.length ? (
                  <p className="mt-2 text-xs text-foreground-muted">
                    No cases have completed yet.
                  </p>
                ) : null}
                {!cases.isLoading && !cases.error && cases.data?.length ? (
                  <div className="mt-2 space-y-2">
                    {cases.data.map((item) => (
                      <CaseCard key={item.id} item={item} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function CaseCard({ item }: { item: Case }) {
  const status = item.verdict?.status ?? item.status
  const passed = status === "passed" || status === "pass"
  return (
    <div className="rounded-lg border border-border bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <span
            className={
              passed
                ? "text-success"
                : status === "failed" || status === "fail"
                  ? "text-destructive"
                  : "text-foreground-muted"
            }
          >
            {passed ? (
              <CheckCircle2 className="size-3.5" />
            ) : status === "failed" || status === "fail" ? (
              <XCircle className="size-3.5" />
            ) : (
              <Clock3 className="size-3.5" />
            )}
          </span>
          Case {item.ordinal ?? "—"} · {item.model || "default"}
        </span>
        <BuildStatus status={status} />
      </div>
      <p className="mt-1 text-foreground-muted">
        {item.verdict?.reason || item.error || "No verdict detail."}
      </p>
      {item.transcript?.length ? (
        <details className="mt-2 rounded-md border border-border bg-muted px-2 py-1">
          <summary className="cursor-pointer font-medium text-foreground">
            Transcript
          </summary>
          <div className="mt-2 space-y-1 border-t border-border pt-2">
            {item.transcript.map((message, index) => (
              <div
                key={`${item.id}-transcript-${index}`}
                className="rounded border border-border bg-background px-2 py-1"
              >
                <p className="text-[11px] font-medium text-foreground-muted capitalize">
                  {message.role || "message"}
                </p>
                <p className="mt-0.5 text-xs whitespace-pre-wrap">
                  {message.content || ""}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
