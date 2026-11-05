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
import { SessionConversationInspector } from "@/components/build/operations/inbox-page"
import { ConversationStatusBadge } from "@/components/build/shared/conversation-status"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { channelLabel } from "@/components/build/shared/channel-catalog"
import { useWideViewport } from "@/components/build/operations/use-wide-viewport"
import { CollectionInspectorOverlay } from "./collection-inspector-overlay"
import type { SessionActivity } from "@/src/lib/tracer/contracts"
import { tracerApi, type CollectionListOptions } from "./api"
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

async function listTracedSessions(options: CollectionListOptions) {
  const page = await tracerApi.sessions.list(options)
  return {
    ...page,
    items: page.items.map((session) => ({ ...session, conversation: null })),
  }
}

export function SessionsPage({
  buildEnabled = false,
}: {
  buildEnabled?: boolean
}) {
  const workspaceHref = useWorkspaceHref()
  const search = useCollectionFilter("sessions")
  const page = useCollectionPages(
    buildEnabled ? tracerApi.sessions.activity : listTracedSessions,
    search.filter,
    5_000
  )
  const { items: sessions } = page
  const pathname = usePathname()
  const params = useSearchParams()
  const selectedId = buildEnabled ? params.get("conversation") : null
  const isWide = useWideViewport(900)
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const selectedRow = sessions.find((session) => session.id === selectedId)
  const detail = useRemote(
    (signal) =>
      tracerApi.sessions.activity({
        filter: `id = ${JSON.stringify(selectedId)}`,
        limit: 1,
        signal,
      }),
    [selectedId],
    { enabled: !!selectedId, intervalMs: 5_000 }
  )
  const selected =
    detail.data?.items.find((session) => session.id === selectedId) ??
    selectedRow
  const sessionHref = (session: SessionActivity) =>
    session.conversation
      ? `${pathname}?${new URLSearchParams({ ...Object.fromEntries(params), conversation: session.id })}`
      : workspaceHref(`/sessions/${encodeURIComponent(session.id)}`)
  const closeConversation = () => {
    const next = new URLSearchParams(params)
    next.delete("conversation")
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, {
      scroll: false,
    })
    returnFocusRef.current?.focus()
  }

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
    <>
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
                  : buildEnabled
                    ? "Agent conversations and traced sessions appear here."
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
                columnIds={
                  buildEnabled
                    ? [
                        "session",
                        "agent",
                        "channel",
                        "status",
                        "traces",
                        "attributes",
                        "updated",
                      ]
                    : ["session", "traces", "attributes", "updated"]
                }
                widths={
                  buildEnabled
                    ? [280, 160, 150, 130, 100, 220, 180]
                    : [280, 100, 300, 180]
                }
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
                      <span className="mt-0.5 block text-xs text-foreground-muted">
                        {sessions.length} sessions
                      </span>
                    </th>
                    {buildEnabled && (
                      <th scope="col" className={collectionTable.heading}>
                        Agent
                      </th>
                    )}
                    {buildEnabled && (
                      <th scope="col" className={collectionTable.heading}>
                        Channel
                      </th>
                    )}
                    {buildEnabled && (
                      <th scope="col" className={collectionTable.heading}>
                        Status
                      </th>
                    )}
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
                      active={session.id === selectedId}
                      onClick={(event) => {
                        returnFocusRef.current = event.currentTarget
                        router.push(sessionHref(session), { scroll: false })
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target !== event.currentTarget ||
                          (event.key !== "Enter" && event.key !== " ")
                        )
                          return
                        event.preventDefault()
                        returnFocusRef.current = event.currentTarget
                        router.push(sessionHref(session), { scroll: false })
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
                          href={sessionHref(session)}
                          onClick={(event) => {
                            event.stopPropagation()
                            returnFocusRef.current = event.currentTarget
                          }}
                        >
                          <SessionKindIcon />
                          <span className="truncate">
                            {session.name ?? "Untitled session"}
                          </span>
                          <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                        </Link>
                      </td>
                      {buildEnabled && (
                        <td className={collectionTable.cell}>
                          {session.conversation?.agentName ?? "—"}
                        </td>
                      )}
                      {buildEnabled && (
                        <td className={collectionTable.cell}>
                          <span className="inline-flex items-center gap-2">
                            <ChannelIcon
                              channel={session.conversation?.channel ?? "api"}
                              size="sm"
                            />
                            <span>
                              {session.conversation
                                ? session.conversation.channel === "web"
                                  ? "Website"
                                  : channelLabel(session.conversation.channel)
                                : "SDK"}
                            </span>
                          </span>
                        </td>
                      )}
                      {buildEnabled && (
                        <td className={collectionTable.cell}>
                          {session.conversation ? (
                            <ConversationStatusBadge
                              status={session.conversation.status}
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                      )}
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
      {selectedId && (
        <CollectionInspectorOverlay
          title="Conversation details"
          description="Read messages, reply, and manage this conversation."
          isWide={isWide}
          defaultSize={68}
          onClose={closeConversation}
          onRestoreFocus={() => returnFocusRef.current?.focus()}
        >
          {selected?.conversation ? (
            <SessionConversationInspector
              key={selected.id}
              session={selected}
              onClose={closeConversation}
              onChanged={() => {
                page.refresh()
                detail.refresh()
              }}
            />
          ) : (
            <div className="p-4">
              <Button variant="ghost" onClick={closeConversation}>
                Close conversation
              </Button>
              {detail.error ? (
                <ErrorState error={detail.error} onRetry={detail.refresh} />
              ) : detail.isLoading ? (
                <LoadingState label="Loading conversation" />
              ) : (
                <EmptyState
                  title="Conversation not found"
                  detail="This conversation may no longer be available in this project."
                />
              )}
            </div>
          )}
        </CollectionInspectorOverlay>
      )}
    </>
  )
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  return (
    <React.Suspense fallback={<LoadingState label="Loading session" />}>
      <SessionDetailContent key={sessionId} sessionId={sessionId} />
    </React.Suspense>
  )
}

function SessionDetailContent({ sessionId }: { sessionId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const load = React.useCallback(
    (signal: AbortSignal) => loadSessionOverview(sessionId, signal),
    [sessionId]
  )
  const { data, error, isLoading, refresh } = useRemote(load, [sessionId], {
    intervalMs: 5_000,
  })
  if (isLoading) return <LoadingState label="Loading session trace hierarchy" />
  if (!data)
    return (
      <ErrorState
        error={error ?? new Error("Session was not returned.")}
        onRetry={refresh}
      />
    )

  return (
    <div className="w-full p-0 sm:p-4">
      {error && (
        <Notice role="alert" variant="error">
          Could not refresh this session. {error.message}{" "}
          <Button variant="outline" size="sm" onClick={refresh}>
            Retry
          </Button>
        </Notice>
      )}
      <SessionTraceInspector
        session={data.session}
        traces={data.traces}
        initialTraceId={searchParams.get("trace") ?? undefined}
        initialSpanId={searchParams.get("span") ?? undefined}
        onSelect={(traceId, spanId) => {
          const next = new URLSearchParams(searchParams.toString())
          if (traceId) next.set("trace", traceId)
          else next.delete("trace")
          if (spanId) next.set("span", spanId)
          else next.delete("span")
          router.replace(next.size ? `${pathname}?${next}` : pathname, {
            scroll: false,
          })
        }}
      />
    </div>
  )
}
