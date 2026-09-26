"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Bell, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Switch } from "@/components/ui/switch"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionPage } from "@/components/tracer/collection-page"
import { CollectionFilterBar } from "@/components/tracer/collection-filter"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { useCollectionFilter } from "@/components/tracer/use-collection-filter"
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import type { CollectionListOptions } from "@/components/tracer/api"
import {
  LogTable,
  LogTableBody,
  LogRow,
  LogRowSelection,
  LogSelectAll,
} from "@/components/tracer/log-table"
import { logTable } from "@/components/tracer/log-table-styles"
import { useRemote } from "@/components/tracer/hooks"
import { formatDate } from "@/components/tracer/format"
import { workspaceRequest } from "@/lib/workspace-api"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import type { ApiList } from "@/src/lib/tracer/contracts"
import type {
  AlertDetailResponse,
  AlertNotification,
  AlertsResponse,
} from "@/src/lib/alerts/contracts"
import { alertIntervalLabel } from "@/src/lib/alerts/templates"
import { AlertCreateDialog } from "./alert-create-dialog"

type PageProps = { projectId: string; projectSlug: string; canManage: boolean }
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to update alert. Try again."
const typeLabel = (type: string) =>
  type === "log_event" ? "Log event" : "Time-window count"
const actionLabel = (action: string) =>
  action === "webhook" ? "Webhook" : "In-app"
const linkClass =
  "font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

function WorkerNotice({ online }: { online: boolean | undefined }) {
  return online === false ? (
    <Notice variant="warning" role="status" className="my-2">
      The alert worker is offline. Notifications will resume when it reconnects.
    </Notice>
  ) : null
}
function EmptyRows({
  columns,
  title,
  description,
}: {
  columns: number
  title: string
  description: string
}) {
  return (
    <tr>
      <td colSpan={columns} className="py-24 text-center">
        <Bell className="mx-auto mb-3 size-6 text-foreground-muted" />
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-foreground-muted">{description}</p>
      </td>
    </tr>
  )
}
function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const all = (rows: { id: string }[]) => ({
    label: "Select all rows",
    disabled: !rows.length,
    checked: !!rows.length && rows.every((row) => selected.has(row.id)),
    partial:
      rows.some((row) => selected.has(row.id)) &&
      !rows.every((row) => selected.has(row.id)),
    onChange: () =>
      setSelected(
        rows.every((row) => selected.has(row.id))
          ? new Set()
          : new Set(rows.map((row) => row.id))
      ),
  })
  return { selected, toggle, all }
}

export function AlertsPage({ projectId, projectSlug, canManage }: PageProps) {
  const router = useRouter()
  const base = `/p/${encodeURIComponent(projectSlug)}/alerts`
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/alerts`
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<AlertsResponse>(endpoint, { signal }),
    [endpoint]
  )
  const state = useRemote(load, [projectId], { intervalMs: 5000 })
  const search = useCollectionFilter("alerts")
  const matches = useMemo(
    () => compileCollectionFilter("alerts", search.filter),
    [search.filter]
  )
  const rows = (state.data?.alerts ?? [])
    .map((alert) => ({
      ...alert,
      ...alert.config,
      status: alert.config.enabled ? "enabled" : "paused",
    }))
    .filter(matches)
  const selection = useSelection()
  return (
    <CollectionPanel label="Alerts">
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel="Loading alerts"
        toolbar={<WorkerNotice online={state.data?.workerOnline} />}
        header={{
          children: (
            <CollectionFilterBar
              resource="alerts"
              {...search}
              isLoading={state.isLoading || state.isRefreshing}
            />
          ),
          exportRows: selection.selected.size
            ? rows.filter((row) => selection.selected.has(row.id))
            : rows,
          exportName: "alerts",
          actions: canManage ? (
            <AlertCreateDialog projectSlug={projectSlug} />
          ) : undefined,
        }}
      >
        <LogTable
          fillHeight
          persistenceKey="alerts"
          widths={[250, 140, 170, 340, 140, 190, 240]}
          columnIds={[
            "name",
            "status",
            "type",
            "condition",
            "action",
            "lastNotified",
            "lastError",
          ]}
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll {...selection.all(rows)} />
              </th>
              {[
                "Name",
                "Status",
                "Type",
                "Condition",
                "Action",
                "Last notification",
                "Last error",
              ].map((label) => (
                <th className={logTable.heading} key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <EmptyRows
                columns={8}
                title={search.filter ? "No matching alerts" : "No alerts yet"}
                description={
                  search.filter
                    ? "Try a different filter."
                    : "Create an alert from a template or configure your own condition."
                }
              />
            }
          >
            {(row, index) => (
              <LogRow
                key={row.id}
                rowLabel={`Open ${row.name}`}
                checked={selection.selected.has(row.id)}
                onClick={() =>
                  router.push(`${base}/${encodeURIComponent(row.id)}`)
                }
              >
                <LogRowSelection
                  index={index}
                  checked={selection.selected.has(row.id)}
                  label={`Select ${row.name}`}
                  onChange={() => selection.toggle(row.id)}
                />
                <td className={logTable.cell}>
                  <Link
                    href={`${base}/${encodeURIComponent(row.id)}`}
                    className={linkClass}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                </td>
                <td className={logTable.cell}>
                  {row.enabled ? "Enabled" : "Paused"}
                </td>
                <td className={`${logTable.cell} text-foreground-muted`}>
                  {typeLabel(row.type)}
                </td>
                <td
                  className={`${logTable.cell} font-mono text-xs`}
                  title={row.filter || "All logs"}
                >
                  {row.filter || "All logs"}
                </td>
                <td className={logTable.cell}>{actionLabel(row.action)}</td>
                <td
                  className={`${logTable.cell} text-xs text-foreground-muted`}
                >
                  {row.lastNotifiedAt
                    ? formatDate(row.lastNotifiedAt)
                    : "Never"}
                </td>
                <td
                  className={`${logTable.cell} text-xs text-destructive`}
                  title={row.lastError ?? undefined}
                >
                  {row.lastError || "—"}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
    </CollectionPanel>
  )
}

export function AlertDetailPage({
  projectId,
  projectSlug,
  canManage,
  alertId,
}: PageProps & { alertId: string }) {
  const router = useRouter()
  const base = `/p/${encodeURIComponent(projectSlug)}/alerts`
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<AlertDetailResponse>(endpoint, { signal }),
    [endpoint]
  )
  const ruleState = useRemote(load, [projectId, alertId], { intervalMs: 5000 })
  const search = useCollectionFilter("alertNotifications")
  const list = useCallback(
    ({
      signal,
      filter,
      cursor,
      limit,
      includeTotal,
    }: CollectionListOptions) => {
      const query = new URLSearchParams({
        filter: filter ?? "",
        limit: String(limit ?? 50),
        includeTotal: String(includeTotal ?? false),
      })
      if (cursor) query.set("cursor", cursor)
      return workspaceRequest<ApiList<AlertNotification>>(
        `${endpoint}/notifications?${query}`,
        { signal }
      )
    },
    [endpoint]
  )
  const history = useCollectionPages(list, search.filter, 5000)
  const selection = useSelection()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const alert = ruleState.data?.alert
  async function toggle(enabled: boolean) {
    if (!alert || pending) return
    setPending(true)
    setError(null)
    try {
      await workspaceRequest(endpoint, {
        method: "PATCH",
        body: JSON.stringify({
          revision: alert.revision,
          config: { ...alert.config, enabled },
        }),
      })
      ruleState.refresh()
    } catch (reason) {
      setError(message(reason))
    } finally {
      setPending(false)
    }
  }
  const state = {
    ...history,
    error: ruleState.error ?? history.error,
    isLoading: ruleState.isLoading || history.isLoading,
    data: alert ? history.data : null,
    refresh: () => {
      ruleState.refresh()
      history.refresh()
    },
  }
  return (
    <CollectionPanel label="Alert notifications">
      {alert && (
        <HeaderSlot name="title">
          <h1
            className="truncate text-sm font-medium"
            title={alert.config.name}
          >
            {alert.config.name}
          </h1>
        </HeaderSlot>
      )}
      <CollectionPage
        className="contents"
        state={state}
        pagination={history}
        loadingLabel="Loading notifications"
        toolbar={
          <>
            <WorkerNotice online={ruleState.data?.workerOnline} />
            {alert && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 text-xs text-foreground-muted">
                <span>
                  {typeLabel(alert.config.type)} ·{" "}
                  {actionLabel(alert.config.action)}
                </span>
                <span>
                  Notify every{" "}
                  {alertIntervalLabel(alert.config.notifyIntervalSeconds)}
                </span>
                {alert.config.type === "time_window" && (
                  <span>
                    At least {alert.config.threshold} matches in{" "}
                    {alertIntervalLabel(alert.config.windowSeconds)}
                  </span>
                )}
                <code className="max-w-full break-words">
                  {alert.config.filter || "All logs"}
                </code>
                {canManage ? (
                  <label className="ml-auto flex items-center gap-2">
                    <Switch
                      checked={alert.config.enabled}
                      disabled={pending}
                      onCheckedChange={(value) => void toggle(value)}
                      aria-label={`Enable ${alert.config.name}`}
                    />
                    {alert.config.enabled ? "Enabled" : "Paused"}
                  </label>
                ) : (
                  <span>{alert.config.enabled ? "Enabled" : "Paused"}</span>
                )}
              </div>
            )}
            {alert?.lastError && (
              <Notice variant="warning" role="status" className="my-2">
                {alert.lastError}
              </Notice>
            )}
            {error && !removing && (
              <Notice variant="error" role="alert" className="my-2">
                {error}
              </Notice>
            )}
          </>
        }
        header={{
          children: (
            <CollectionFilterBar
              resource="alertNotifications"
              {...search}
              isLoading={state.isLoading || history.isRefreshing}
            />
          ),
          exportRows: selection.selected.size
            ? history.items.filter((row) => selection.selected.has(row.id))
            : history.items,
          exportName: "alert-notifications",
          actions:
            alert && canManage ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${base}/${encodeURIComponent(alertId)}/edit`}>
                    <Pencil className="size-4" />
                    <PanelActionLabel>Edit alert</PanelActionLabel>
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete alert"
                  disabled={pending}
                  onClick={() => {
                    setError(null)
                    setRemoving(true)
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            ) : undefined,
        }}
      >
        <LogTable
          fillHeight
          persistenceKey="alert-notifications"
          widths={[200, 140, 140, 120, 130, 240, 280]}
          columnIds={[
            "created",
            "status",
            "action",
            "matches",
            "attempts",
            "trace",
            "error",
          ]}
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll {...selection.all(history.items)} />
              </th>
              {[
                "Created",
                "Status",
                "Action",
                "Matches",
                "Attempts",
                "Trace",
                "Last error",
              ].map((label) => (
                <th className={logTable.heading} key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={history.items}
            empty={
              <EmptyRows
                columns={8}
                title={
                  search.filter
                    ? "No matching notifications"
                    : "No notifications yet"
                }
                description={
                  search.filter
                    ? "Try a different filter."
                    : "Notifications will appear here when this alert matches a log or reaches its threshold."
                }
              />
            }
          >
            {(row, index) => (
              <LogRow key={row.id} checked={selection.selected.has(row.id)}>
                <LogRowSelection
                  index={index}
                  checked={selection.selected.has(row.id)}
                  label={`Select notification ${row.id}`}
                  onChange={() => selection.toggle(row.id)}
                />
                <td className={`${logTable.cell} text-xs`}>
                  {formatDate(row.createdAt)}
                </td>
                <td
                  className={`${logTable.cell} ${row.status === "failed" ? "text-destructive" : row.status === "delivered" ? "text-success" : "text-foreground-muted"}`}
                >
                  {row.status.charAt(0).toUpperCase() + row.status.slice(1)}
                </td>
                <td className={logTable.cell}>{actionLabel(row.action)}</td>
                <td className={logTable.cell}>{row.matchCount}</td>
                <td className={logTable.cell}>{row.attempts}</td>
                <td className={logTable.cell}>
                  {row.traceId ? (
                    <Link
                      className={linkClass}
                      href={`/p/${encodeURIComponent(projectSlug)}/traces/${encodeURIComponent(row.traceId)}`}
                      aria-label={`View trace ${row.traceName || row.traceId}`}
                    >
                      {row.traceName || row.traceId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td
                  className={`${logTable.cell} text-xs text-foreground-muted`}
                  title={row.lastError ?? undefined}
                >
                  {row.lastError || "—"}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
      <Dialog
        open={removing}
        onOpenChange={(open) => {
          if (!pending) setRemoving(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete alert?</DialogTitle>
            <DialogDescription>
              This removes “{alert?.config.name}”, its pending deliveries and
              notification history. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  await workspaceRequest(endpoint, { method: "DELETE" })
                  router.push(base)
                } catch (reason) {
                  setError(message(reason))
                  setPending(false)
                }
              }}
            >
              Delete alert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CollectionPanel>
  )
}
