"use client"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { projectFetch } from "@/lib/workspace-routing"

import { useWorkspaceHref } from "./workspace-path"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { tracerApi } from "./api"
import type { Dataset, JsonObject } from "@/src/lib/tracer/contracts"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog"
import { StructuredValueEditor } from "@/components/ui/structured-value-editor"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-select"
import { LoadingState } from "@/components/ui/loading-state"
import { Notice } from "@/components/ui/notice"
import { inputOverridesSchema } from "@/src/lib/tracer/eval-input-overrides"
import type { ManagedPrompt } from "@/src/lib/tracer/prompts"
import type { PromptOverrides } from "@/src/lib/tracer/prompt-overrides"
import { ProjectModelField } from "./project-model-field"
import { ScorerPicker } from "./scorer-picker"
import { DatasetKindIcon } from "./dataset-kind-icon"
import {
  jsonDocument,
  parseValueDocument,
} from "@/src/lib/tracer/dataset-editor"
import { Input } from "@/components/ui/input"
import { FormRow } from "@/components/ui/form-row"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Braces, FileText, Play, Plug, RotateCcw, Trash2 } from "lucide-react"

const overridesSchema: JsonObject = { type: "object" }

export function ConnectedEvalButton({
  appId: initialApp = "",
  datasetId: initialDataset = "",
  compact = false,
}: {
  appId?: string
  datasetId?: string
  compact?: boolean
}) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [apps, setApps] = useState<{ id: string; name: string }[]>([])
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [prompts, setPrompts] = useState<ManagedPrompt[]>([])
  const [promptOverrides, setPromptOverrides] = useState<PromptOverrides>({})
  const [appId, setApp] = useState(initialApp)
  const [datasetId, setDataset] = useState(initialDataset)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [overrides, setOverrides] = useState(() => jsonDocument({}))
  let overridesError = ""
  let overridesInvalid = false
  let inputOverrides: JsonObject | undefined
  if (overrides.text.trim()) {
    try {
      const parsed = inputOverridesSchema.safeParse(
        parseValueDocument(overrides)
      )
      if (!parsed.success) {
        overridesInvalid = true
        overridesError = "Input overrides must be an object with named keys."
      } else if (Object.keys(parsed.data).length) {
        inputOverrides = parsed.data
      }
    } catch {
      // The shared editor displays syntax errors next to the draft.
      overridesInvalid = true
    }
  }
  async function load(next: boolean) {
    setOpen(next)
    if (!next) return
    setError("")
    setLoading(true)
    try {
      const [catalog, connections, ds, ps] = await Promise.all([
        projectFetch("/api/apps/config").then((r) => r.json()),
        projectFetch("/api/apps").then((r) => r.json()),
        tracerApi.datasets.list(),
        projectFetch("/api/prompts").then((r) => r.json()),
      ])
      if (ps.error) throw new Error(ps.error.message)
      if (catalog.error || connections.error)
        throw new Error(catalog.error?.message ?? connections.error.message)
      setApps([
        ...new Map(
          [...(catalog.data ?? []), ...(connections.data ?? [])].map(
            (a: { id: string; name: string }) => [a.id, a]
          )
        ).values(),
      ] as { id: string; name: string }[])
      setDatasets(ds.items)
      setPrompts(
        (ps.data as ManagedPrompt[]).filter((p) => p.publishedVersion !== null)
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  async function run() {
    if (overridesInvalid) return
    setBusy(true)
    setError("")
    try {
      const result = await tracerApi.evals.create({
        mode: "connected",
        appId,
        datasetId,
        evaluatorIds: selected,
        ...(Object.keys(promptOverrides).length ? { promptOverrides } : {}),
        ...(inputOverrides === undefined ? {} : { inputOverrides }),
        name: `${apps.find((a) => a.id === appId)?.name ?? "App"} · ${datasets.find((d) => d.id === datasetId)?.name ?? "Dataset"}`,
      })
      setOpen(false)
      router.push(workspaceHref(`/evals/${result.id}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => void load(next)}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size={compact ? "responsive-sm" : "sm"}
          aria-label="Run dataset"
          title="Run dataset"
        >
          <Play aria-hidden="true" className="size-3.5" />
          <PanelActionLabel
            className={compact ? "hidden xl:inline" : undefined}
          >
            Run dataset
          </PanelActionLabel>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Run dataset against an app</DialogTitle>
          <DialogDescription>
            Choose an app, dataset, and scorers.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-3 min-w-0">
          <FormRow label="App" controlWidth="wide">
            <Select
              disabled={loading || busy}
              value={appId || null}
              items={apps.map((app) => ({ value: app.id, label: app.name }))}
              onValueChange={(value) => setApp(value ?? "")}
            >
              <SelectTrigger aria-label="App" className="w-full">
                <span className="flex min-w-0 items-center gap-2">
                  <Plug
                    aria-hidden
                    className="size-3.5 shrink-0 text-foreground-muted"
                  />
                  <SelectValue placeholder="Choose app" />
                </span>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {apps.map((app) => (
                  <SelectItem key={app.id} value={app.id}>
                    <span className="flex items-center gap-2">
                      <Plug
                        aria-hidden
                        className="size-3.5 shrink-0 text-foreground-muted"
                      />
                      {app.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow label="Dataset" controlWidth="wide">
            <Select
              disabled={loading || busy}
              value={datasetId || null}
              items={datasets.map((dataset) => ({
                value: dataset.id,
                label: dataset.name,
              }))}
              onValueChange={(value) => setDataset(value ?? "")}
            >
              <SelectTrigger aria-label="Dataset" className="w-full">
                <span className="flex min-w-0 items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
                  <DatasetKindIcon kind="dataset" />
                  <SelectValue placeholder="Choose dataset" />
                </span>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {datasets.map((dataset) => (
                  <SelectItem key={dataset.id} value={dataset.id}>
                    <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
                      <DatasetKindIcon kind="dataset" />
                      {dataset.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          {loading && (
            <LoadingState compact label="Loading apps and datasets…" />
          )}
          {!loading && !error && (!apps.length || !datasets.length) && (
            <Notice>Add an app and dataset to run an evaluation.</Notice>
          )}
          <FormRow label="Scorers" controlWidth="wide">
            <ScorerPicker
              value={selected}
              onValueChange={setSelected}
              disabled={loading || busy}
            />
          </FormRow>
          <fieldset disabled={loading || busy} className="min-w-0">
            <legend className="sr-only">Managed prompts</legend>
            <FormRow label="Prompt override" controlWidth="wide">
              <Select
                value={null}
                disabled={
                  loading ||
                  busy ||
                  prompts.every((prompt) =>
                    Object.hasOwn(promptOverrides, prompt.slug)
                  )
                }
                onValueChange={(value) => {
                  if (!value) return
                  setPromptOverrides((previous) => ({
                    ...previous,
                    [value]: {},
                  }))
                }}
              >
                <SelectTrigger
                  aria-label="Add prompt override"
                  className="w-full"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText
                      aria-hidden
                      className="size-3.5 shrink-0 text-foreground-muted"
                    />
                    <SelectValue placeholder="Choose published prompt" />
                  </span>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {prompts
                    .filter(
                      (prompt) => !Object.hasOwn(promptOverrides, prompt.slug)
                    )
                    .map((prompt) => (
                      <SelectItem key={prompt.id} value={prompt.slug}>
                        <span className="flex items-center gap-2">
                          <FileText
                            aria-hidden
                            className="size-3.5 shrink-0 text-foreground-muted"
                          />
                          {prompt.name}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!loading && !prompts.length && (
                <p className="mt-2 text-xs text-foreground-muted">
                  No published prompts.
                </p>
              )}
            </FormRow>
            {Object.entries(promptOverrides).map(([slug, override]) => {
              const prompt = prompts.find((p) => p.slug === slug)
              const update = (value: typeof override) =>
                setPromptOverrides((previous) => ({
                  ...previous,
                  [slug]: value,
                }))
              return (
                <div
                  key={slug}
                  className="mx-3 my-3 min-w-0 overflow-hidden rounded-md border border-border"
                >
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate text-sm">
                      {prompt?.name ?? slug}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${slug} override`}
                      onClick={() =>
                        setPromptOverrides((previous) =>
                          Object.fromEntries(
                            Object.entries(previous).filter(
                              ([key]) => key !== slug
                            )
                          )
                        )
                      }
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                  <FormRow label="Version" controlWidth="wide">
                    <Input
                      aria-label={`Version for ${slug}`}
                      className="min-w-0"
                      type="number"
                      min={1}
                      max={prompt?.publishedVersion ?? undefined}
                      placeholder={`Latest published (v${prompt?.publishedVersion ?? "?"})`}
                      value={override.version ?? ""}
                      onChange={(event) =>
                        update({
                          ...override,
                          version: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </FormRow>
                  <ProjectModelField
                    model={override.model ?? ""}
                    disabled={busy}
                    onChange={(selection) =>
                      update({ ...override, model: selection.model })
                    }
                  />
                  <p className="px-3 py-2 text-xs text-foreground-muted">
                    {override.model
                      ? `Run model: ${override.model}`
                      : "Uses the model saved in the selected published version."}
                  </p>
                  {override.model && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => update({ ...override, model: undefined })}
                    >
                      <RotateCcw aria-hidden className="size-3.5" />
                      Use published model
                    </Button>
                  )}
                </div>
              )
            })}
          </fieldset>
          <InspectorSection
            label="Input overrides"
            icon={<Braces aria-hidden className="size-3.5" />}
            variant="form"
          >
            <StructuredValueEditor
              label="Input overrides"
              value={overrides}
              onChange={setOverrides}
              disabled={busy}
              schema={overridesSchema}
              autoSize
            />
            {overridesError && (
              <Notice variant="error" role="alert" className="mt-2">
                {overridesError}
              </Notice>
            )}
          </InspectorSection>
        </div>
        {error && (
          <Notice role="alert" variant="error">
            {error}
          </Notice>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
          <Button
            loading={busy}
            disabled={
              loading ||
              overridesInvalid ||
              Object.entries(promptOverrides).some(
                ([slug, value]) =>
                  value.version !== undefined &&
                  (!Number.isSafeInteger(value.version) ||
                    value.version < 1 ||
                    value.version >
                      (prompts.find((p) => p.slug === slug)?.publishedVersion ??
                        0))
              ) ||
              !appId ||
              !datasetId ||
              !selected.length
            }
            onClick={() => void run()}
          >
            <Play aria-hidden className="size-3.5" />
            {busy ? "Starting…" : "Run app and score traces"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
