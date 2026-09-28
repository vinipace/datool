"use client"

import type { ReactNode } from "react"
import { Download } from "lucide-react"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import {
  SelectionActionButton,
  SelectionToolbar,
} from "@/components/ui/selection-toolbar"
import { downloadTraceExport } from "./trace-list-utils"

export type CollectionSelection = {
  rows: unknown[]
  onClear: () => void
  actions?: ReactNode
  label?: string
  onExportJson?: () => void
}

/** Count and export share the exact same selection supplied by the resource. */
export function CollectionSelectionActions({
  rows,
  onClear,
  actions,
  label,
  exportName = "rows",
  onExportJson,
}: CollectionSelection & { exportName?: string }) {
  if (!rows.length) return null
  return (
    <SelectionToolbar count={rows.length} onClear={onClear} label={label}>
      {actions}
      <SelectionActionButton
        onClick={onExportJson ?? (() =>
          downloadTraceExport({
            content: JSON.stringify(rows, null, 2),
            filename: `datool-selected-${exportName}.json`,
            type: "application/json",
          })
        )}
      >
        <Download aria-hidden="true" className="size-3.5" />
        <PanelActionLabel>Export JSON</PanelActionLabel>
      </SelectionActionButton>
    </SelectionToolbar>
  )
}
