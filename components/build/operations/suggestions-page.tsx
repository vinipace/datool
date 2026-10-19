"use client"

import * as React from "react"
import {
  Check,
  CircleX,
  Lightbulb,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { buildApi, asList, asRecord } from "./build-api"
import {
  BuildEmpty,
  BuildFrame,
  BuildState,
  BuildStatus,
  BuildToolbar,
} from "./build-page"

type Suggestion = {
  id: string
  question?: string
  evidenceCount?: number
  negativeCount?: number
  status?: string
  createdAt?: string
  updatedAt?: string
  sampleEventIds?: string[]
}

function listSuggestions(value: unknown) {
  const record = asRecord(value)
  return asList<Suggestion>(record.items ?? value)
}

function formatWhen(value?: string) {
  if (!value) return "No update date"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "No update date" : date.toLocaleString()
}

export function SuggestionsPage() {
  const workspaceHref = useWorkspaceHref()
  const [status, setStatus] = React.useState("open")
  const [search, setSearch] = React.useState("")
  const state = useRemote(
    (signal) =>
      buildApi
        .call<unknown>(
          "build_list_knowledge_gap_suggestions",
          { limit: 100, status: status || undefined },
          signal
        )
        .then(listSuggestions),
    [status],
    { intervalMs: 30_000 }
  )
  const resolve = useMutation()
  const refreshSuggestions = useMutation()
  const visibleSuggestions = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return state.data ?? []
    return (state.data ?? []).filter((suggestion) =>
      `${suggestion.question ?? ""} ${suggestion.status ?? ""}`
        .toLowerCase()
        .includes(query)
    )
  }, [search, state.data])
  const summary = React.useMemo(() => {
    const suggestions = state.data ?? []
    return {
      total: suggestions.length,
      evidence: suggestions.reduce(
        (total, suggestion) => total + (suggestion.evidenceCount ?? 0),
        0
      ),
      negative: suggestions.reduce(
        (total, suggestion) => total + (suggestion.negativeCount ?? 0),
        0
      ),
    }
  }, [state.data])

  async function change(
    suggestion: Suggestion,
    nextStatus: "resolved" | "ignored"
  ) {
    try {
      await resolve.run(() =>
        buildApi.call("build_update_knowledge_gap_status", {
          id: suggestion.id,
          status: nextStatus,
        })
      )
      state.refresh()
    } catch {
      // useMutation exposes the failure below the queue.
    }
  }

  async function deriveSuggestions() {
    try {
      await refreshSuggestions.run(() =>
        buildApi.call("build_refresh_knowledge_gap_suggestions", { limit: 100 })
      )
      state.refresh()
    } catch {
      // useMutation exposes the failure below the queue.
    }
  }

  return (
    <BuildFrame
      title="Suggestions"
      description="Find questions your agent struggled with and decide where its answers need improvement."
      breadcrumbs={[
        { label: "Build", href: workspaceHref("/build/agents") },
        { label: "Suggestions", href: workspaceHref("/build/suggestions") },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={state.refresh}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => void deriveSuggestions()}
            loading={refreshSuggestions.isPending}
          >
            <Sparkles className="size-3.5" /> Find suggestions
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <section
          className="grid gap-3 sm:grid-cols-3"
          aria-label="Suggestion overview"
        >
          <SummaryCard
            label={
              status
                ? `${status[0].toUpperCase()}${status.slice(1)} suggestions`
                : "Suggestions in view"
            }
            value={summary.total}
            detail={
              status === "open"
                ? "Questions needing a decision"
                : "Items in the selected status"
            }
          />
          <SummaryCard
            label="Matching questions"
            value={summary.evidence}
            detail="Times these questions appeared"
          />
          <SummaryCard
            label="Answers needing attention"
            value={summary.negative}
            detail="Low confidence or poor feedback"
          />
        </section>

        <BuildToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Search questions…"
        >
          <Select
            aria-label="Suggestion status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-8 w-auto min-w-28 text-xs"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
            <option value="">All statuses</option>
          </Select>
        </BuildToolbar>

        <BuildState
          isLoading={state.isLoading}
          error={state.error}
          onRetry={state.refresh}
        >
          {visibleSuggestions.length ? (
            <div
              className="grid gap-3 lg:grid-cols-2"
              role="list"
              aria-label="Knowledge gap suggestions"
            >
              {visibleSuggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  busy={resolve.isPending}
                  onChange={(nextStatus) => void change(suggestion, nextStatus)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <BuildEmpty
                title={
                  search
                    ? "No matching suggestions"
                    : "No knowledge gaps to review"
                }
                description={
                  search
                    ? "Try another phrase or clear the search."
                    : status === "open"
                      ? "New unresolved questions and negative feedback will appear here."
                      : "There are no suggestions in this status yet."
                }
                action={
                  search ? (
                    <Button variant="outline" onClick={() => setSearch("")}>
                      <Search className="size-3.5" /> Clear search
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )}
          {resolve.error ? (
            <Notice className="mt-3" variant="error">
              {resolve.error.message}
            </Notice>
          ) : null}
          {refreshSuggestions.error ? (
            <Notice className="mt-3" variant="error">
              {refreshSuggestions.error.message}
            </Notice>
          ) : null}
        </BuildState>
      </div>
    </BuildFrame>
  )
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {value.toLocaleString()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-foreground-muted">{detail}</p>
      </CardContent>
    </Card>
  )
}

function SuggestionCard({
  suggestion,
  busy,
  onChange,
}: {
  suggestion: Suggestion
  busy: boolean
  onChange: (status: "resolved" | "ignored") => void
}) {
  const isOpen = suggestion.status === "open"
  const evidenceCount = suggestion.evidenceCount ?? 0
  const negativeCount = suggestion.negativeCount ?? 0
  return (
    <Card role="listitem">
      <CardHeader className="flex items-start gap-3 pb-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background text-foreground-muted">
          <Lightbulb className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle className="text-sm leading-relaxed">
              {suggestion.question || "Unlabelled question"}
            </CardTitle>
            <BuildStatus status={suggestion.status} />
          </div>
          <CardDescription className="mt-1">
            Updated {formatWhen(suggestion.updatedAt || suggestion.createdAt)}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-background px-3 py-2 text-xs">
          <div>
            <p className="text-foreground-muted">Matching questions</p>
            <p className="mt-1 text-base font-semibold tabular-nums">
              {evidenceCount}
            </p>
            <p className="text-[11px] text-foreground-muted">
              Times this question appeared
            </p>
          </div>
          <div>
            <p className="text-foreground-muted">Answers needing attention</p>
            <p className="mt-1 text-base font-semibold tabular-nums">
              {negativeCount}
            </p>
            <p className="text-[11px] text-foreground-muted">
              Low confidence or feedback
            </p>
          </div>
        </div>
        {suggestion.sampleEventIds?.length ? (
          <p className="text-xs text-foreground-muted">
            Based on {suggestion.sampleEventIds.length} conversation event
            {suggestion.sampleEventIds.length === 1 ? "" : "s"}.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!isOpen}
            loading={busy}
            onClick={() => onChange("resolved")}
          >
            <Check className="size-3.5" /> Resolve
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={!isOpen}
            loading={busy}
            onClick={() => onChange("ignored")}
          >
            <CircleX className="size-3.5" /> Ignore
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
