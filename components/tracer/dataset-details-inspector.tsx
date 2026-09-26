"use client"

import * as React from "react"
import Link from "next/link"
import { BookOpen, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/ui/notice"
import { StructuredValueEditor } from "@/components/ui/structured-value-editor"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Dataset, PatchDatasetInput } from "@/src/lib/tracer/contracts"
import {
  jsonDocument,
  parseValueDocument,
} from "@/src/lib/tracer/dataset-editor"
import { tracerApi } from "./api"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionPagination } from "./collection-pagination"
import { ErrorState, LoadingState } from "./primitives"
import { formatRelative } from "./format"
import { useWorkspaceHref } from "./workspace-path"

function DatasetRuns({ datasetId }: { datasetId: string }) {
  const page = useCollectionPages(
    tracerApi.evals.list,
    `datasetId = ${JSON.stringify(datasetId)}`,
    0
  )
  const workspaceHref = useWorkspaceHref()
  return (
    <div className="grid gap-3">
      <p className="text-xs text-foreground-muted">
        Evaluation runs using this dataset
      </p>
      {page.isLoading && <LoadingState label="Loading dataset runs" />}
      {page.error && <ErrorState error={page.error} onRetry={page.refresh} />}
      {!page.isLoading && !page.error && !page.items.length && (
        <p className="py-8 text-center text-sm text-foreground-muted">
          This dataset has no runs yet.
        </p>
      )}
      {page.items.map((run) => (
        <Link
          key={run.id}
          className="flex items-center justify-between gap-3 rounded-md bg-muted p-3 text-sm hover:bg-surface-row-hover"
          href={workspaceHref(`/evals/${encodeURIComponent(run.id)}`)}
        >
          <span className="truncate">
            {run.name || "Untitled run"}
            <span className="mt-1 block text-xs text-foreground-muted">
              {formatRelative(run.createdAt)}
            </span>
          </span>
          <span className="text-xs text-foreground-muted">{run.status}</span>
        </Link>
      ))}
      <CollectionPagination {...page} />
    </div>
  )
}

export function DatasetDetailsInspector({
  dataset,
  onSave,
  onClose,
}: {
  dataset: Dataset
  onSave: (patch: PatchDatasetInput) => Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = React.useState("details")
  const [description, setDescription] = React.useState(
    dataset.description ?? ""
  )
  const [metadata, setMetadata] = React.useState(() =>
    jsonDocument(dataset.metadata ?? {})
  )
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  async function save() {
    setError("")
    try {
      const parsed = parseValueDocument(metadata)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Dataset metadata must be an object.")
      setSaving(true)
      await onSave({ description: description || null, metadata: parsed })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <TabsList aria-label="Dataset details">
          <TabsTrigger value="details">
            <BookOpen className="size-3.5" />
            Details
          </TabsTrigger>
          <TabsTrigger value="runs">
            <Play className="size-3.5" />
            Runs
          </TabsTrigger>
        </TabsList>
        <Button
          className="md:hidden"
          variant="ghost"
          size="icon-sm"
          aria-label="Close dataset details"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <TabsContent value="details" className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-5">
          <div>
            <h2 className="text-sm font-medium">
              {dataset.name.split("/").at(-1)}
            </h2>
            <p className="mt-1 text-xs text-foreground-muted">
              {dataset.itemCount} rows · Select a row to inspect its fields.
            </p>
          </div>
          <label className="grid gap-2 text-sm text-foreground-muted">
            Description
            <Textarea
              aria-label="Dataset description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Enter dataset description"
              className="min-h-20 bg-muted"
            />
          </label>
          <div className="grid gap-2">
            <span className="text-sm text-foreground-muted">Metadata</span>
            <StructuredValueEditor
              label="Dataset metadata"
              value={metadata}
              onChange={setMetadata}
            />
          </div>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <div className="flex justify-end">
            <Button size="sm" loading={saving} onClick={() => void save()}>
              Save details
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="w-full justify-between"
            onClick={() => setTab("runs")}
          >
            Recently used in <Play className="size-3.5" />
          </Button>
        </div>
      </TabsContent>
      <TabsContent value="runs" className="flex-1 overflow-y-auto p-4">
        <DatasetRuns datasetId={dataset.id} />
      </TabsContent>
    </Tabs>
  )
}
