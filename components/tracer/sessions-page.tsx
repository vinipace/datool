"use client"

import { collectionTable } from "./collection-table-styles"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import {
  CollectionTableBody,
  CollectionRowSelection,
  CollectionSelectAll,
  CollectionTable,
  CollectionRow,
} from "./collection-table"
import { ArrowUpRight, Route } from "lucide-react"

import { SessionKindIcon } from "./span-kind-icon"
import { SessionTraceInspector } from "./trace-inspector"
import { loadSessionOverview } from "./session-detail-loader"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { tracerApi } from "./api"
import { formatDate, formatRelative } from "./format"
import { useRemote } from "./hooks"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { useWorkspaceHref } from "./workspace-path"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ValuePreview,
} from "./primitives"

export function SessionsPage() {
  const workspaceHref = useWorkspaceHref()
  const search = useCollectionFilter("sessions")
  const page = useCollectionPages(tracerApi.sessions.list, search.filter, 5_000)
  const { items: sessions } = page
  const router = useRouter()
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const checkedCount = sessions.filter((session) =>
    checkedIds.has(session.id)
  ).length
  const allChecked = sessions.length > 0 && checkedCount === sessions.length
  function toggleSession(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <CollectionPanel label="Sessions">
      <CollectionPage
        className="contents"
        state={page}
        loadingLabel="Loading sessions"
        header={{
          exportRows: sessions,
          exportName: "sessions",
          children: (
            <CollectionFilterBar
              resource="sessions"
              {...search}
              isLoading={page.isRefreshing || page.isLoading}
            />
          ),
        }}
        pagination={page}
        isEmpty={sessions.length === 0}
        empty={
          <EmptyState
            detail={
              search.filter
                ? "Try changing or clearing the filter."
                : "Sessions appear when traced code supplies a session ID, through the SDK."
            }
            icon={Route}
            title={search.filter ? "No matching sessions" : "No sessions yet"}
          />
        }
      >
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CollectionTable
              persistenceKey="sessions"
              fillHeight
              columnIds={["session", "traces", "attributes", "updated"]}
              widths={[280, 100, 300, 180]}
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th className="px-3 align-middle" scope="col">
                    <CollectionSelectAll
                      checked={allChecked}
                      partial={checkedCount > 0 && !allChecked}
                      disabled={!sessions.length}
                      label="Select all visible sessions"
                      onChange={() =>
                        setCheckedIds((current) => {
                          const next = new Set(current)
                          for (const session of sessions) {
                            if (allChecked) next.delete(session.id)
                            else next.add(session.id)
                          }
                          return next
                        })
                      }
                    />
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Session
                    <span className="mt-0.5 block text-xs">
                      {sessions.length} sessions
                    </span>
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Traces
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Attributes
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Updated
                  </th>
                </tr>
              </thead>
              <CollectionTableBody rows={sessions}>
                {(session, index) => (
                  <CollectionRow
                    checked={checkedIds.has(session.id)}
                    key={session.id}
                    tabIndex={0}
                    aria-label={`Open ${session.name ?? "Untitled session"}`}
                    onClick={() =>
                      router.push(
                        workspaceHref(
                          `/sessions/${encodeURIComponent(session.id)}`
                        )
                      )
                    }
                    onKeyDown={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        (event.key !== "Enter" && event.key !== " ")
                      )
                        return
                      event.preventDefault()
                      router.push(
                        workspaceHref(
                          `/sessions/${encodeURIComponent(session.id)}`
                        )
                      )
                    }}
                  >
                    <CollectionRowSelection
                      index={index}
                      checked={checkedIds.has(session.id)}
                      label={`Select session ${index + 1}: ${session.name ?? "Untitled session"}`}
                      onChange={() => toggleSession(session.id)}
                    />
                    <td className={collectionTable.cell}>
                      <Link
                        className="inline-flex max-w-full items-center gap-2 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        title={session.id}
                        href={workspaceHref(
                          `/sessions/${encodeURIComponent(session.id)}`
                        )}
                      >
                        <SessionKindIcon />
                        <span className="truncate">
                          {session.name ?? "Untitled session"}
                        </span>
                        <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    </td>
                    <td className={cn(collectionTable.cell, "tabular-nums")}>
                      {session.traceCount}
                    </td>
                    <td className={collectionTable.cell}>
                      <ValuePreview value={session.attributes} />
                    </td>
                    <td
                      className={cn(collectionTable.cell, "tabular-nums")}
                      title={formatDate(session.updatedAt)}
                    >
                      {formatRelative(session.updatedAt)}
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </div>
        </section>
      </CollectionPage>
    </CollectionPanel>
  )
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  return <React.Suspense fallback={<LoadingState label="Loading session" />}>
    <SessionDetailContent key={sessionId} sessionId={sessionId} />
  </React.Suspense>
}

function SessionDetailContent({ sessionId }: { sessionId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const load = React.useCallback((signal: AbortSignal) => loadSessionOverview(sessionId, signal), [sessionId])
  const { data, error, isLoading, refresh } = useRemote(load, [sessionId], { intervalMs: 5_000 })
  if (isLoading) return <LoadingState label="Loading session trace hierarchy" />
  if (!data) return <ErrorState error={error ?? new Error("Session was not returned.")} onRetry={refresh} />

  return <div className="w-full p-0 sm:p-4">
    {error && <Notice role="alert" variant="error">Could not refresh this session. {error.message} <Button variant="outline" size="sm" onClick={refresh}>Retry</Button></Notice>}
    <SessionTraceInspector session={data.session} traces={data.traces}
      initialTraceId={searchParams.get("trace") ?? undefined}
      initialSpanId={searchParams.get("span") ?? undefined}
      onSelect={(traceId, spanId) => {
        const next = new URLSearchParams(searchParams.toString())
        if (traceId) next.set("trace", traceId)
        else next.delete("trace")
        if (spanId) next.set("span", spanId)
        else next.delete("span")
        router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false })
      }} />
  </div>
}
