"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Columns3, Download, LayoutList, MoreHorizontal, RefreshCw, Rows3, Table2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { downloadTraceExport } from "./trace-list-utils"

import { CollectionHeaderContext, type HeaderSlotName } from "./collection-header-context"
export function HeaderSlot({ name, children }: React.PropsWithChildren<{ name: HeaderSlotName }>) {
  const slots = React.useContext(CollectionHeaderContext)
  return slots[name] ? createPortal(children, slots[name]) : null
}
export const headerButtonClass = "h-8 shrink-0 gap-1.5 rounded-md px-2 text-xs shadow-none"

export type DisplaySettingGroup = {
  label: string
  items: {
    id: string
    label: string
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }[]
}

export function HeaderDisplay({ settings = [], rowHeight, onRowHeightChange, columns, onChange, view, onViewChange }: { settings?: DisplaySettingGroup[]; rowHeight?: "compact" | "tall"; onRowHeightChange?: (height: "compact" | "tall") => void; view?: "table" | "cards"; onViewChange?: (view: "table" | "cards") => void; columns: { id: string; label: string; visible: boolean; disabled?: boolean }[]; onChange: (id: string, visible: boolean) => void }) {
  const { displayIconOnly } = React.useContext(CollectionHeaderContext)
  return <HeaderSlot name="display">
    <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" className={headerButtonClass} aria-label="Display"><Columns3 className="size-3.5" />{!displayIconOnly && <span className="hidden @min-[640px]/page:inline">Display</span>}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {rowHeight || view ? <>
        <DropdownMenuLabel>View</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view === "cards" ? "cards" : rowHeight ?? "table"} onValueChange={value => {
          if (value === "cards") onViewChange?.("cards")
          else if (value === "compact" || value === "tall") {
            onRowHeightChange?.(value)
            onViewChange?.("table")
          } else if (value === "table") onViewChange?.("table")
        }}>
          {rowHeight && onRowHeightChange ? <>
            <DropdownMenuRadioItem value="compact"><Table2 className="size-3.5" />Compact</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="tall"><Rows3 className="size-3.5" />Tall</DropdownMenuRadioItem>
          </> : <DropdownMenuRadioItem value="table"><Table2 className="size-3.5" />Table</DropdownMenuRadioItem>}
          {view && onViewChange ? <DropdownMenuRadioItem value="cards"><LayoutList className="size-3.5" />Card</DropdownMenuRadioItem> : null}
        </DropdownMenuRadioGroup>
        {columns.length || settings.length ? <DropdownMenuSeparator /> : null}
      </> : null}
      {settings.map(group => <React.Fragment key={group.label}>
        <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
        {group.items.map(setting => <DropdownMenuSub key={setting.id}>
          <DropdownMenuSubTrigger>
            {setting.label}
            <span className="ml-auto pl-4 text-xs text-foreground-muted">{setting.options.find(option => option.value === setting.value)?.label ?? setting.value}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={setting.value} onValueChange={setting.onChange}>
              {setting.options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>)}
        <DropdownMenuSeparator />
      </React.Fragment>)}
      {columns.length ? <DropdownMenuLabel>Visible columns</DropdownMenuLabel> : null}{columns.map(column => <DropdownMenuCheckboxItem key={column.id} checked={column.visible} disabled={column.disabled} onCheckedChange={visible => onChange(column.id, visible)} onSelect={event => event.preventDefault()}>{column.label}</DropdownMenuCheckboxItem>)}</DropdownMenuContent>
  </DropdownMenu></HeaderSlot>
}

export function CollectionHeaderControls({ children, actions, displayActions, onRefresh, isRefreshing, onExportJson, onExportCsv, exportRows, exportName = "rows", menuActions, showExport = true, menuTriggerRef, onMenuCloseAutoFocus }: React.PropsWithChildren<{
  actions?: React.ReactNode; displayActions?: React.ReactNode; onRefresh: () => void; isRefreshing?: boolean; onExportJson?: () => void; onExportCsv?: () => void; exportRows?: unknown[]; exportName?: string; menuActions?: React.ReactNode; showExport?: boolean; menuTriggerRef?: React.Ref<HTMLButtonElement>; onMenuCloseAutoFocus?: React.ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"]
}>) {
  const { refreshInMenu } = React.useContext(CollectionHeaderContext)
  const exportJson = onExportJson ?? (exportRows ? () => downloadTraceExport({ content: JSON.stringify(exportRows, null, 2), filename: `datool-${exportName}.json`, type: "application/json" }) : undefined)
  return <>
    <HeaderSlot name="filter">{children}</HeaderSlot>
    <HeaderSlot name="actions">{actions}</HeaderSlot>
    <HeaderSlot name="display">{displayActions}</HeaderSlot>
    {!refreshInMenu && <HeaderSlot name="refresh"><Button variant="ghost" className={headerButtonClass} aria-label="Refresh" onClick={onRefresh}><RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} /></Button></HeaderSlot>}
    <HeaderSlot name="menu"><DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" className={headerButtonClass} aria-label="More actions" ref={menuTriggerRef}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={onMenuCloseAutoFocus}>
        {refreshInMenu && <><DropdownMenuItem onSelect={onRefresh}><RefreshCw className={cn("size-3.5", isRefreshing && "animate-spin")} />Refresh</DropdownMenuItem>{(menuActions || showExport) && <DropdownMenuSeparator />}</>}
        {menuActions}{showExport && <><DropdownMenuLabel>Export loaded rows</DropdownMenuLabel>
        <DropdownMenuItem disabled={!exportJson} onSelect={exportJson}><Download className="size-3.5" />Export JSON</DropdownMenuItem>
        {onExportCsv ? <DropdownMenuItem onSelect={onExportCsv}><Download className="size-3.5" />Export CSV</DropdownMenuItem> : null}</>}
      </DropdownMenuContent>
    </DropdownMenu></HeaderSlot>
  </>
}
