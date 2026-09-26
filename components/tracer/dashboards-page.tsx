"use client"
import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useWorkspaceHref } from "./workspace-path"
import type { Dashboard } from "@/src/lib/tracer/dashboards"
import { dashboardRequest } from "./dashboard-utils"
import { DashboardCreateDialog } from "./dashboard-create-dialog"
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
import { CollectionPage, CollectionSearch } from "./collection-page"
import { formatDate } from "./format"

export function DashboardsPage() {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const load = React.useCallback(
    () => dashboardRequest<Dashboard[]>("/api/dashboards"),
    []
  )
  const state = useRemote(load, [])
  const [search, setSearch] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const rows = (state.data ?? []).filter((row) =>
    `${row.name} ${row.description}`
      .toLowerCase()
      .includes(search.toLowerCase())
  )
  return (
    <CollectionPanel label="Dashboards">
      <CollectionPage
        className="contents"
        selection={{
          rows: rows.filter((row) => selected.has(row.id)),
          onClear: () => setSelected(new Set()),
        }}
        state={state}
        loadingLabel="Loading dashboards"
        header={{
          exportRows: rows,
          exportName: "dashboards",
          actions: <DashboardCreateDialog />,
          children: (
            <CollectionSearch
              label="Search dashboards"
              value={search}
              onChange={setSearch}
            />
          ),
        }}
      >
        <LogTable
          persistenceKey="dashboards"
          fillHeight
          widths={[280, 340, 110, 220, 190]}
          columnIds={["name", "description", "widgets", "models", "updated"]}
          reorderable
          orderStorageKey="datool.dashboards.columns"
        >
          <thead className={logTable.head}>
            <tr>
              <th className={logTable.heading}>
                <LogSelectAll
                  label="Select all dashboards"
                  disabled={!rows.length}
                  checked={!!rows.length && rows.every((r) => selected.has(r.id))}
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
              {["Name", "Description", "Widgets", "Models", "Updated"].map(
                (label) => (
                  <th key={label} className={logTable.heading}>
                    {label}
                  </th>
                )
              )}
            </tr>
          </thead>
          <LogTableBody
            rows={rows}
            empty={
              <tr>
                <td
                  colSpan={6}
                  className="py-24 text-center text-sm text-foreground-muted"
                >
                  {search
                    ? "No matching dashboards."
                    : "No dashboards yet. Create one to start exploring your data."}
                </td>
              </tr>
            }
          >
            {(row, index) => (
              <LogRow
                key={row.id}
                checked={selected.has(row.id)}
                rowLabel={`Open ${row.name}`}
                onClick={() =>
                  router.push(
                    workspaceHref(`/dashboards/${encodeURIComponent(row.id)}`)
                  )
                }
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
                <td className={`${logTable.cell} font-medium`}>
                  <Link
                    className="text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={workspaceHref(
                      `/dashboards/${encodeURIComponent(row.id)}`
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.name}
                  </Link>
                </td>
                <td className={`${logTable.cell} truncate text-foreground-muted`}>
                  {row.description || "—"}
                </td>
                <td className={logTable.cell}>{row.widgets.length}</td>
                <td className={logTable.cell}>
                  {[
                    ...new Set(
                      row.widgets.map((w) => w.query.measures[0].split(".")[0])
                    ),
                  ].join(", ")}
                </td>
                <td className={`${logTable.cell} text-foreground-muted`}>
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
