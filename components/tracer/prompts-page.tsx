"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { MessagesSquare, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { PromptEditorSkeleton } from "@/components/ui/prompt-editor-skeleton"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import {
  promptPublicationLabel,
  type ManagedPrompt,
} from "@/src/lib/tracer/prompts"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"
import {
  LogTable,
  LogTableBody,
  LogRow,
  LogRowSelection,
  LogSelectAll,
} from "./log-table"
import { logTable } from "./log-table-styles"
import { useRemote } from "./hooks"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { useTableView } from "./use-table-view"
import { formatDate } from "./format"
import { PromptEditor } from "./prompt-editor"
import { promptRequest as request } from "./prompt-request"

export function PromptsPage() {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const storageScope = useWorkspaceStorageScope()
  const tableView = useTableView({
    resource: "prompts",
    settingsStorageKey: `datool:prompts:${storageScope}:settings`,
    orderStorageKey: "datool.prompts.columns",
  })
  const load = React.useCallback(() => request<ManagedPrompt[]>(), [])
  const state = useRemote(load, [])
  const search = useCollectionFilter("prompts")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const matches = React.useMemo(
    () => compileCollectionFilter("prompts", search.filter),
    [search.filter]
  )
  const rows = (state.data ?? []).filter(matches)
  return (
    <CollectionPanel label="Prompts">
      <CollectionPage
        className="contents"
        selection={{
          rows: rows.filter((row) => selected.has(row.id)),
          onClear: () => setSelected(new Set()),
        }}
        state={state}
        loadingLabel="Loading prompts"
        savedView={tableView.savedView}
        toolbar={
          tableView.storageError ? (
            <Notice variant="error" role="status" className="mb-2">
              {tableView.storageError}
            </Notice>
          ) : null
        }
        header={{
          exportRows: rows,
          exportName: "prompts",
          children: (
            <CollectionFilterBar
              resource="prompts"
              {...search}
              isLoading={state.isLoading || state.isRefreshing}
            />
          ),
          actions: (
            <Button size="sm" asChild>
              <Link href={workspaceHref("/prompts/new")}>
                <Plus className="size-4" />
                <PanelActionLabel>New prompt</PanelActionLabel>
              </Link>
            </Button>
          ),
        }}
      >
        <LogTable
          fillHeight
          enableCardView
          settings={tableView.settings}
          onSettingsChange={tableView.onSettingsChange}
          columnOrderStore={tableView.columnOrderStore}
          widths={[240, 200, 150, 260, 160, 100, 190]}
          columnIds={[
            "name",
            "slug",
            "model",
            "description",
            "status",
            "version",
            "updated",
          ]}
          reorderable
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll
                  label="Select all prompts"
                  disabled={!rows.length}
                  checked={
                    !!rows.length && rows.every((r) => selected.has(r.id))
                  }
                  partial={
                    rows.some((r) => selected.has(r.id)) &&
                    !rows.every((r) => selected.has(r.id))
                  }
                  onChange={() =>
                    setSelected(
                      rows.every((r) => selected.has(r.id))
                        ? new Set()
                        : new Set(rows.map((r) => r.id))
                    )
                  }
                />
              </th>
              {[
                "Name",
                "Slug",
                "Model",
                "Description",
                "Status",
                "Version",
                "Updated",
              ].map((label) => (
                <th key={label} className={logTable.heading}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <tr>
                <td colSpan={8} className="py-24 text-center">
                  <MessagesSquare className="mx-auto mb-3 size-6 text-foreground-muted" />
                  <p className="font-medium">
                    {search.filter
                      ? "No matching prompts"
                      : "Create your first prompt"}
                  </p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    Manage, version and test the prompts your agents use.
                  </p>
                  <Button className="mt-4" size="sm" variant="outline" asChild>
                    <Link href={workspaceHref("/prompts/new")}>
                      <Plus className="size-4" />
                      New prompt
                    </Link>
                  </Button>
                </td>
              </tr>
            }
          >
            {(row, index) => (
              <LogRow
                rowLabel={`Open ${row.name}`}
                onClick={() =>
                  router.push(
                    workspaceHref(`/prompts/${encodeURIComponent(row.id)}`)
                  )
                }
                key={row.id}
                checked={selected.has(row.id)}
              >
                <LogRowSelection
                  index={index}
                  checked={selected.has(row.id)}
                  label={`Select ${row.name}`}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      return next
                    })
                  }
                />
                <td className={logTable.cell}>
                  <Link
                    className="font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={workspaceHref(
                      `/prompts/${encodeURIComponent(row.id)}`
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                </td>
                <td
                  className={`${logTable.cell} font-mono text-xs text-foreground-muted`}
                >
                  {row.slug}
                </td>
                <td className={logTable.cell}>
                  <span className="text-xs text-foreground-muted">
                    {row.model}
                  </span>
                </td>
                <td
                  className={`${logTable.cell} truncate text-foreground-muted`}
                >
                  {row.description || "—"}
                </td>
                <td className={`${logTable.cell} text-foreground-muted`}>
                  {promptPublicationLabel(row)}
                </td>
                <td className={logTable.cell}>
                  {row.publishedVersion === null
                    ? "—"
                    : `v${row.publishedVersion}`}
                </td>
                <td
                  className={`${logTable.cell} text-xs text-foreground-muted`}
                >
                  {formatDate(row.updatedAt)}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
    </CollectionPanel>
  )
}

export function NewPromptPage() {
  return <PromptEditor />
}

export function PromptDetailPage({ promptId }: { promptId: string }) {
  const load = React.useCallback(
    (signal: AbortSignal) =>
      request<ManagedPrompt>(
        `/${encodeURIComponent(promptId)}`,
        "GET",
        undefined,
        signal
      ),
    [promptId]
  )
  const state = useRemote(load, [promptId])
  if (state.error)
    return (
      <Notice variant="error" role="alert" className="m-4">
        <p>{state.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={state.refresh}
        >
          Retry
        </Button>
      </Notice>
    )
  if (!state.data) return <PromptEditorSkeleton />
  return <PromptEditor key={promptId} prompt={state.data} />
}
