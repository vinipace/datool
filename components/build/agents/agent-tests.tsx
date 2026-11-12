"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { tracerApi } from "@/components/tracer/api"
import { DatasetDetailPage } from "@/components/tracer/datasets-page"
import { useRemote } from "@/components/tracer/hooks"
import { ErrorState, LoadingState } from "@/components/tracer/primitives"
import type { Dataset } from "@/src/lib/tracer/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-select"

export function AgentTests({
  agentId,
  agentName,
  requireJourneys = false,
  onRequireJourneys,
  onPublish,
  pending,
  unpublished,
}: {
  agentId: string
  agentName: string
  requireJourneys?: boolean
  onRequireJourneys?: (required: boolean) => void
  onPublish?: () => Promise<unknown>
  pending?: boolean
  unpublished?: boolean
}) {
  const params = useSearchParams()
  const state = useRemote(
    async (signal) => {
      const items: Dataset[] = []
      let cursor: string | undefined
      do {
        const page = await tracerApi.datasets.list({
          agentId,
          limit: 200,
          cursor,
          signal,
        })
        items.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return items
    },
    [agentId]
  )
  const [created, setCreated] = React.useState<Dataset | null>(null)
  const datasets =
    created && !state.data?.some((d) => d.id === created.id)
      ? [created, ...(state.data ?? [])]
      : (state.data ?? [])
  const requested = params.get("datasetId")
  const datasetId =
    requested && datasets.some((d) => d.id === requested)
      ? requested
      : datasets[0]?.id
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const choose = (id: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set("datasetId", id)
    for (const key of ["item", "itemTab", "objectView", "filter", "inspector"])
      url.searchParams.delete(key)
    window.history.pushState(null, "", url)
  }
  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const dataset = await tracerApi.datasets.create({
        agentId,
        name: name.trim(),
      })
      setCreated(dataset)
      choose(dataset.id)
      state.refresh()
      setOpen(false)
      setName("")
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Select
          value={datasetId ?? null}
          onValueChange={(id) => {
            if (id === "__new_test_dataset__") {
              setError("")
              setName("")
              setOpen(true)
            } else if (id) choose(id)
          }}
          items={[
            ...datasets.map((d) => ({ value: d.id, label: d.name })),
            { value: "__new_test_dataset__", label: "New dataset" },
          ]}
        >
          <SelectTrigger aria-label="Test dataset" className="w-56 max-w-full">
            <SelectValue placeholder="Choose dataset" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {datasets.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
            <SelectItem value="__new_test_dataset__">New dataset</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-3">
          {onRequireJourneys ? (
            <label
              title="Required tests must pass before publishing"
              className="flex items-center gap-2 text-xs"
            >
              <Checkbox
                aria-label="Require tests before publishing"
                checked={requireJourneys}
                disabled={pending}
                onChange={(event) => onRequireJourneys(event.target.checked)}
              />
              Require tests
            </label>
          ) : null}
          {requireJourneys && unpublished ? (
            <span className="text-xs text-foreground-muted">Draft</span>
          ) : null}
          {requireJourneys && onPublish ? (
            <Button
              size="sm"
              aria-label="Publish tested version"
              disabled={pending || !unpublished}
              loading={pending}
              onClick={() => void onPublish().catch(() => {})}
            >
              Publish
            </Button>
          ) : null}
        </div>
      </div>
      {state.error ? (
        <ErrorState error={state.error} onRetry={state.refresh} />
      ) : state.isLoading && !datasetId ? (
        <LoadingState label="Loading agent tests" />
      ) : datasetId ? (
        <DatasetDetailPage
          key={datasetId}
          datasetId={datasetId}
          testAgent={{ id: agentId, name: agentName }}
        />
      ) : (
        <p className="p-6 text-sm text-foreground-muted">
          Create a dataset to add test inputs and expected answers. Results will
          appear beside each row.
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void create(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>New test dataset</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              aria-label="Dataset name"
              placeholder="Dataset name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
            />
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
            <DialogFooter>
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                Create dataset
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
