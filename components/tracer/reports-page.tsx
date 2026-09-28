"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileChartColumn } from "lucide-react"
import { Notice } from "@/components/ui/notice"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import type { ReportSummary } from "@/src/lib/tracer/reports"
import { reportTemplates } from "@/src/lib/tracer/report-templates"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { useTableView } from "./use-table-view"
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
import { dashboardRequest } from "./dashboard-utils"
import { formatDate } from "./format"
import { ReportCreateDialog } from "./report-create-dialog"

export function ReportsPage() {
  const href = useWorkspaceHref()
  const router = useRouter()
  const scope = useWorkspaceStorageScope()
  const table = useTableView({
    resource: "reports",
    settingsStorageKey: `datool:reports:${scope}:settings`,
    orderStorageKey: "datool.reports.columns",
  })
  const load = React.useCallback(
    (signal: AbortSignal) =>
      dashboardRequest<ReportSummary[]>("/api/reports", "GET", undefined, {
        signal,
      }),
    []
  )
  const state = useRemote(load, [])
  const search = useCollectionFilter("reports")
  const [selected, setSelected] = React.useState(new Set<string>())
  const matches = React.useMemo(
    () => compileCollectionFilter("reports", search.filter),
    [search.filter]
  )
  const rows = (state.data ?? []).filter(matches)
  const create = <ReportCreateDialog />
  return (
    <CollectionPanel label="Reports">
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel="Loading reports"
        savedView={table.savedView}
        selection={{
          rows: rows.filter((row) => selected.has(row.id)),
          onClear: () => setSelected(new Set()),
        }}
        toolbar={
          table.storageError ? (
            <Notice variant="error" role="status">
              {table.storageError}
            </Notice>
          ) : null
        }
        header={{
          exportRows: rows,
          exportName: "reports",
          children: (
            <CollectionFilterBar
              resource="reports"
              {...search}
              isLoading={state.isLoading || state.isRefreshing}
            />
          ),
          actions: create,
        }}
      >
        <LogTable
          fillHeight
          enableCardView
          reorderable
          settings={table.settings}
          onSettingsChange={table.onSettingsChange}
          columnOrderStore={table.columnOrderStore}
          widths={[80, 260, 110, 180, 210, 300, 100, 190]}
          columnIds={[
            "number",
            "name",
            "status",
            "author",
            "template",
            "description",
            "widgets",
            "frozen",
          ]}
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll
                  label="Select all reports"
                  disabled={!rows.length}
                  checked={
                    !!rows.length && rows.every((row) => selected.has(row.id))
                  }
                  partial={
                    rows.some((row) => selected.has(row.id)) &&
                    !rows.every((row) => selected.has(row.id))
                  }
                  onChange={() =>
                    setSelected(
                      rows.every((row) => selected.has(row.id))
                        ? new Set()
                        : new Set(rows.map((row) => row.id))
                    )
                  }
                />
              </th>
              {[
                "Number",
                "Name",
                "Status",
                "Author",
                "Template",
                "Description",
                "Widgets",
                "Frozen at",
              ].map((name) => (
                <th className={logTable.heading} key={name}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <tr>
                <td colSpan={9} className="py-24 text-center">
                  <FileChartColumn className="mx-auto mb-3 size-6 text-foreground-muted" />
                  <p className="font-medium">
                    {search.filter
                      ? "No matching reports"
                      : "Create your first report"}
                  </p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    Create a private draft, review it, then publish and share.
                  </p>
                  <div className="mt-4">{create}</div>
                </td>
              </tr>
            }
          >
            {(row, index) => (
              <LogRow
                key={row.id}
                checked={selected.has(row.id)}
                rowLabel={`Open ${row.name}`}
                onClick={() => router.push(href(`/reports/${row.number}`))}
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
                <td className={`${logTable.cell} text-foreground-muted`}>
                  #{row.number}
                </td>
                <td className={`${logTable.cell} font-medium`}>
                  <Link
                    className="hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={href(`/reports/${row.number}`)}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                </td>
                <td className={logTable.cell}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${row.status === "draft" ? "bg-warning" : "bg-success"}`}
                    />
                    {row.status === "draft" ? "Draft" : "Published"}
                  </span>
                </td>
                <td className={`${logTable.cell} text-foreground-muted`}>
                  {row.author?.name ?? "Not recorded"}
                </td>
                <td className={logTable.cell}>
                  {reportTemplates.find(
                    (template) => template.id === row.templateId
                  )?.name ?? "Custom dashboard"}
                </td>
                <td className={`${logTable.cell} text-foreground-muted`}>
                  {row.description || "—"}
                </td>
                <td className={logTable.cell}>{row.widgetCount}</td>
                <td className={`${logTable.cell} text-foreground-muted`}>
                  {formatDate(row.frozenAt)}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
      </CollectionPage>
    </CollectionPanel>
  )
}
