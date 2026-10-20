"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Plus } from "lucide-react"
import { tracerApi } from "@/components/tracer/api"
import { DatasetDetailPage } from "@/components/tracer/datasets-page"
import { useRemote } from "@/components/tracer/hooks"
import { ErrorState, LoadingState } from "@/components/tracer/primitives"
import type { Dataset } from "@/src/lib/tracer/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
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
}: {
  agentId: string
  agentName: string
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
    [agentId],
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
            if (id) choose(id)
          }}
          items={datasets.map((d) => ({ value: d.id, label: d.name }))}
        >
          <SelectTrigger aria-label="Test dataset" className="w-64 max-w-full">
            <SelectValue placeholder="Choose dataset" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {datasets.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError("")
            setOpen(true)
          }}
        >
          <Plus className="size-3.5" /> New dataset
        </Button>
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
