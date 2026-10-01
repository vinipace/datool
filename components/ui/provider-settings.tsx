"use client"

import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { Button } from "./button"
import { Skeleton } from "./skeleton"
import { collectionTable } from "@/components/tracer/collection-table-styles"

export function ProviderSettingsLayout({
  description,
  children,
}: {
  description: string
  children: ReactNode
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <p className="text-sm text-foreground-muted">{description}</p>
        {children}
      </div>
    </div>
  )
}

export type ProviderSettingsRow = {
  id: string
  name: string
  description: string
  icon: ReactNode
  kind: string
  status: string
  secret: string
  detail: ReactNode
  actions?: ReactNode
}

/** Settings collections share the product table surface and compact actions. */
export function ProviderSettingsTable({
  label,
  rows,
  detailHeading,
  loading,
  unavailable,
  emptyMessage,
}: {
  label: string
  rows: ProviderSettingsRow[]
  detailHeading: string
  loading: boolean
  unavailable: boolean
  emptyMessage: string
}) {
  const headings = [
    "Name",
    "Type",
    "Status",
    "Secret",
    detailHeading,
    "Actions",
  ]
  return (
    <div className="space-y-2">
      {loading && (
        <p role="status" className="sr-only">
          Loading {label.toLowerCase()}…
        </p>
      )}
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="overflow-x-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table
          className={`${collectionTable.table} min-w-[900px]`}
          aria-busy={loading}
        >
          <caption className="sr-only">{label}</caption>
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col className="w-[18%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead className={collectionTable.head}>
            <tr>
              {headings.map((heading) => (
                <th key={heading} scope="col" className={collectionTable.heading}>
                  {heading === "Actions" ? (
                    <span className="sr-only">Actions</span>
                  ) : (
                    heading
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 3 }, (_, index) => (
                <tr
                  key={index}
                  aria-hidden="true"
                  className={`${collectionTable.row} cursor-default`}
                >
                  {headings.map((heading) => (
                    <td key={heading} className={`${collectionTable.cell} h-16`}>
                      <Skeleton className="h-4 w-2/3" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <tr key={row.id} className={`${collectionTable.row} cursor-default`}>
                  <td className={`${collectionTable.cell} py-3`}>
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center">
                        {row.icon}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">{row.name}</p>
                        <p className="mt-0.5 truncate text-xs text-foreground-muted">
                          {row.description}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={`${collectionTable.cell} text-foreground-muted`}>
                    {row.kind}
                  </td>
                  <td className={`${collectionTable.cell} text-foreground-muted`}>
                    {row.status}
                  </td>
                  <td className={`${collectionTable.cell} text-foreground-muted`}>
                    {row.secret}
                  </td>
                  <td className={collectionTable.cell}>{row.detail}</td>
                  <td className={collectionTable.cell}>
                    <div className="flex items-center justify-end gap-1">
                      {row.actions}
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={headings.length}
                  className="h-28 px-3 text-center text-sm text-foreground-muted"
                >
                  {unavailable
                    ? "Provider settings are unavailable."
                    : emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ProviderPicker({
  options,
  onSelect,
}: {
  options: { id: string; name: string; icon: ReactNode; configured: boolean }[]
  onSelect: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {options.map((option, index) => (
        <Button
          key={option.id}
          type="button"
          autoFocus={index === 0}
          variant="outline"
          aria-label={option.name}
          className="relative h-28 w-full flex-col gap-3 px-3 whitespace-normal"
          onClick={() => onSelect(option.id)}
        >
          {option.icon}
          <span>{option.name}</span>
          {option.configured && (
            <Check
              aria-label="Configured"
              className="absolute top-2 right-2 size-3.5 text-foreground-muted"
            />
          )}
        </Button>
      ))}
    </div>
  )
}
