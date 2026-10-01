"use client"
import * as React from "react"
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table"
import { cn } from "@/lib/utils"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { Button } from "./button"

/** Pure data adapter for embedded views; uses the product table styles. */
export function DataTable<T>({ data, columns, caption, emptyMessage = "No results." }: {
  data: T[]; columns: ColumnDef<T>[]; caption: string; emptyMessage?: string
}) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [page, setPage] = React.useState(0)
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() })
  const rows = table.getRowModel().rows
  const pageCount = Math.max(1, Math.ceil(rows.length / 50))
  const current = Math.min(page, pageCount - 1)
  return <div className="min-w-0 space-y-2">
    <div className="overflow-x-auto"><table className={collectionTable.table}>
      <caption className="sr-only">{caption}</caption>
      <thead className={collectionTable.head}>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id} className={collectionTable.heading} aria-sort={header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : undefined}>{header.column.getCanSort() ? <Button variant="ghost" size="sm" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === "asc" ? " ↑" : header.column.getIsSorted() === "desc" ? " ↓" : ""}</Button> : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead>
      <tbody>{rows.slice(current * 50, (current + 1) * 50).map(row => <tr key={row.id} className={cn(collectionTable.row, "cursor-default")}>{row.getVisibleCells().map(cell => <td key={cell.id} className={cn(collectionTable.cell, "break-words py-2")}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
    </table></div>
    {!rows.length && <p className="p-3 text-sm text-foreground-muted">{emptyMessage}</p>}
    {pageCount > 1 && <div className="flex items-center justify-end gap-2"><Button variant="outline" size="sm" disabled={!current} onClick={() => setPage(current - 1)}>Previous</Button><span className="text-sm text-foreground-muted">{current + 1} / {pageCount}</span><Button variant="outline" size="sm" disabled={current + 1 >= pageCount} onClick={() => setPage(current + 1)}>Next</Button></div>}
  </div>
}
