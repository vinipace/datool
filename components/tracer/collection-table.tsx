"use client"

import { InfiniteScroll, type InfiniteScrollState } from "./infinite-scroll"

import { defaultTableSettings, type CollectionTableSettings } from "@/src/lib/tracer/custom-views"

/* eslint-disable react-hooks/incompatible-library */

import * as React from "react"
import { animate } from "motion"
import { useReducedMotion } from "motion/react"
import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { arrayMove, horizontalListSortingStrategy, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { resolveCollectionColumnOrder, type ColumnOrderStore } from "@/src/lib/tracer/collection-column-order"
import { getCoreRowModel, useReactTable, type ColumnSizingState, type VisibilityState } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { collectionTable } from "./collection-table-styles"
import { useTableView } from "./use-table-view"
import { useColumnValues } from "./use-computed-columns"
import { ColumnEditor, ComputedValue } from "./eval-computed-columns"
import { CustomViewControls } from "./custom-view-controls"
import { fieldRow, type FieldRow } from "@/src/lib/tracer/field-row"
import { pageViewResources } from "@/src/lib/tracer/view-resources"
import type { ComputedCell, ComputedColumn } from "@/src/lib/tracer/computed-columns"
import { useWorkspaceStorageScope } from "./workspace-path"
import { Notice } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import type { ComputedColumnStore } from "@/src/lib/tracer/computed-column-store"
import { useColumnWebMcp } from "./use-column-webmcp"
import { HeaderDisplay } from "./collection-header"
import { CollectionColumnEditorContext } from "./collection-column-editor-context"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"

/** Omit the index to keep the checkbox visible instead of swapping it with a row number. */
export function CollectionRowSelection({ index, checked, label, onChange, disabled, className, align = "middle" }: { index?: number; checked: boolean; label: string; onChange: () => void; disabled?: boolean; className?: string; align?: "top" | "middle" }) {
  const context = React.useContext(CollectionTableContext)
  const Cell = context?.view === "cards" ? "div" : "td"
  return (
    <Cell className={cn("rounded-l-md px-3", context?.view === "cards" ? "py-3" : align === "top" ? "align-top pt-4" : "align-middle", className)} onClick={(event) => event.stopPropagation()}>
      <span className="relative flex size-4 items-center justify-center">
        {index !== undefined && <span aria-hidden="true" className={cn("text-xs text-muted-foreground tabular-nums group-hover:invisible group-focus-within:invisible", checked && "invisible")}>
          {index + 1}
        </span>}
        <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={onChange}
          className={cn("absolute inset-0 size-4 cursor-pointer accent-selection-control opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 disabled:cursor-default disabled:opacity-50", (checked || index === undefined) && "opacity-100")} />
      </span>
    </Cell>
  )
}

export function CollectionSelectAll({ checked, partial, disabled, label, onChange }: { checked: boolean; partial: boolean; disabled: boolean; label: string; onChange: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = partial }, [partial])
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} className="size-4 cursor-pointer accent-selection-control" />
}

type CollectionTableContextValue = {
  extraFields?: { columns: ComputedColumn[]; cells: Record<string, Record<string, ComputedCell>> }

  rowHeight?: "compact" | "tall"
  animateRows: boolean
  appearedRows: React.RefObject<Set<string>>
  scrollRef: React.RefObject<HTMLDivElement | null>
  headerHeight: number
  columnCount: number
  visibleIndices: number[]
  view: "table" | "cards"
  headers: React.ReactNode[]
  actionIndices: number[]
  sourceIds: string[]
  labels: string[]
  reorderable: boolean
  onDragEnd: (event: DragEndEvent) => void
}
const CollectionTableContext = React.createContext<CollectionTableContextValue | null>(null)
const EMPTY_DATA: unknown[] = []

function hasSelectionControl(node: React.ReactNode): boolean {
  return React.Children.toArray(node).some(child => {
    if (!React.isValidElement<React.PropsWithChildren<{ type?: string }>>(child)) return false
    return child.type === CollectionSelectAll || (child.type === "input" && child.props.type === "checkbox") || hasSelectionControl(child.props.children)
  })
}

function SortableCollectionHeader({ id, label, enabled, element, menu, selected, onSelectHeader }: {
  selected: boolean
  onSelectHeader: (additive: boolean) => void
  menu?: { count: number; hide?: () => void; left?: () => void; right?: () => void }
  id: string
  label: string
  enabled: boolean
  element: React.ReactElement<React.ComponentPropsWithRef<"th">>
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !enabled })
  const [edit, setEdit] = React.useState<(() => void) | null>(null)
  const registerEditor = React.useCallback((handler: (() => void) | null) => setEdit(() => handler), [])
  const heading = React.cloneElement(element, {
    ...(enabled ? attributes : {}),
    ...(enabled ? listeners : {}),
    // Preserve table semantics while making the existing label the drag target.
    role: "columnheader",
    "aria-label": element.props["aria-label"] ?? (enabled ? label : undefined),
    title: enabled ? "Ctrl/Cmd-click to select multiple columns. Drag to reorder. Or press Space, use arrow keys, then Space to drop." : element.props.title,
    ref: node => { setNodeRef(node); setActivatorNodeRef(node) },
    onClick: event => {
      element.props.onClick?.(event)
      if (!menu || (event.target as HTMLElement).closest("button, input, [role=separator]")) return
      onSelectHeader(event.metaKey || event.ctrlKey)
    },
    onKeyDown: event => {
      element.props.onKeyDown?.(event)
      // Nested editor buttons and resize handles keep their keyboard actions.
      if (enabled && event.target === event.currentTarget && !event.defaultPrevented) listeners?.onKeyDown?.(event)
    },
    className: cn(element.props.className, selected && "bg-selection ring-1 ring-inset ring-ring", menu && "data-[state=open]:bg-selection data-[state=open]:ring-1 data-[state=open]:ring-inset data-[state=open]:ring-ring", enabled && "touch-none select-none cursor-grab active:cursor-grabbing [&_button]:cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", isDragging && "z-30 bg-surface-canvas shadow-md opacity-80"),
    style: { ...element.props.style, transform: CSS.Translate.toString(transform), transition },
  })
  return <CollectionColumnEditorContext.Provider value={registerEditor}>
    {menu ? <ContextMenu>
      <ContextMenuTrigger asChild>{heading}</ContextMenuTrigger>
      <ContextMenuContent>
        {edit && <><ContextMenuItem onSelect={edit}>Edit column</ContextMenuItem><ContextMenuSeparator /></>}
        <ContextMenuItem disabled={!menu.left} onSelect={menu.left}>Move left</ContextMenuItem>
        <ContextMenuItem disabled={!menu.right} onSelect={menu.right}>Move right</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!menu.hide} onSelect={menu.hide}>{menu.count > 1 ? `Hide ${menu.count} columns` : "Hide column"}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu> : heading}
  </CollectionColumnEditorContext.Provider>
}

/** Shared Display and rendering; persistence and additional settings are configured with props. */
export function CollectionTable({ pagination, displaySettings, persistenceKey, enableRowHeight = true, computedColumnStore, selectionActions, selectionToolbarClassName, selectionColumnWidth = 44, settings: controlledSettings, onSettingsChange: controlledOnSettingsChange, widths, columnIds, actionColumnIds = [], reorderable = true, orderStorageKey, columnOrderStore, children, displayControls = true, enableCardView = true, defaultView = "table", fillHeight = false, animateRows = false }: React.PropsWithChildren<{ pagination?: InfiniteScrollState; displaySettings?: React.ComponentProps<typeof HeaderDisplay>["settings"]; persistenceKey?: string; enableRowHeight?: boolean; computedColumnStore?: ComputedColumnStore; selectionActions?: React.ReactNode; selectionToolbarClassName?: string; selectionColumnWidth?: number; settings?: CollectionTableSettings; onSettingsChange?: React.Dispatch<React.SetStateAction<CollectionTableSettings>>; widths: number[]; columnIds?: string[]; actionColumnIds?: string[]; reorderable?: boolean; orderStorageKey?: string; columnOrderStore?: ColumnOrderStore; displayControls?: boolean; enableCardView?: boolean; defaultView?: "table" | "cards"; fillHeight?: boolean; animateRows?: boolean }>) {
  const [selectedHeaders, setSelectedHeaders] = React.useState<Set<string>>(() => new Set())
  const appearedRows = React.useRef(new Set<string>())
  const storageScope = useWorkspaceStorageScope()
  const storageKey = persistenceKey ? `datool:table:${storageScope}:${persistenceKey}` : undefined
  const defaultSettings = React.useMemo(() => ({ ...defaultTableSettings, view: defaultView }), [defaultView])
  const tableView = useTableView({
    settingsStorageKey: controlledSettings ? undefined : storageKey,
    orderStorageKey: columnOrderStore ? undefined : orderStorageKey ?? (storageKey ? `${storageKey}:columns` : undefined),
    defaultSettings,
    persistenceEnabled: !controlledSettings,
  })
  const automaticFields = !computedColumnStore && !!tableView.resource
  const fieldColumns = automaticFields ? tableView.computed.columns : []
  const fieldKind = tableView.resource ? pageViewResources[tableView.resource].objectType : "table-row"
  const fieldRows: FieldRow[] = []
  function findRows(nodes: React.ReactNode) {
    React.Children.forEach(nodes, node => {
      if (!React.isValidElement<{ rows?: unknown[]; children?: React.ReactNode }>(node)) return
      if (node.type === CollectionTableBody && node.props.rows) fieldRows.push(...node.props.rows.map(row => fieldRow(fieldKind, row)))
      else if (node.type === React.Fragment) findRows(node.props.children)
    })
  }
  if (automaticFields) findRows(children)
  const fieldCells = useColumnValues(fieldRows, fieldColumns)
  if (automaticFields) {
    columnIds = [...(columnIds ?? widths.map((_, index) => `column-${index}`)), ...fieldColumns.map(field => `computed:${field.id}`), "add-auto-field"]
    widths = [...widths, ...fieldColumns.map(() => 240), 160]
    actionColumnIds = [...actionColumnIds, "add-auto-field"]
    const editor = <ColumnEditor objectKind={fieldKind} addedFields={fieldColumns} rows={fieldRows} addLabel="Custom Fields" onSave={field => { void tableView.computed.store.update([...fieldColumns, field]) }} />
    const extraHeaders = [...fieldColumns.map(field => <th key={field.id} className={collectionTable.head}><ColumnEditor objectKind={fieldKind} column={field} rows={fieldRows} onSave={saved => { void tableView.computed.store.update(fieldColumns.map(current => current.id === field.id ? saved : current)) }} onDelete={() => { void tableView.computed.store.update(fieldColumns.filter(current => current.id !== field.id)) }} /></th>), <th key="add-auto-field" className={collectionTable.head}>{editor}</th>]
    children = React.Children.map(children, child => {
      if (!React.isValidElement<React.PropsWithChildren>(child) || child.type !== "thead") return child
      return React.cloneElement(child, {}, React.Children.map(child.props.children, row => React.isValidElement<React.PropsWithChildren>(row) && row.type === "tr" ? React.cloneElement(row, {}, [...React.Children.toArray(row.props.children), ...extraHeaders]) : row))
    })
  }
  const settings = controlledSettings ?? tableView.settings
  const onSettingsChange = controlledOnSettingsChange ?? tableView.onSettingsChange
  const rowHeight = enableRowHeight ? settings.rowHeight ?? "compact" : undefined
  const setRowHeight = (rowHeight: "compact" | "tall") => onSettingsChange(current => ({ ...current, rowHeight }))
  const view = settings.view
  const setView = (view: "table" | "cards") => onSettingsChange(current => ({ ...current, view }))
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const headRef = React.useRef<HTMLElement>(null)
  const [viewportWidth, setViewportWidth] = React.useState(0)
  const [headerHeight, setHeaderHeight] = React.useState(50)
  const [viewportHeight, setViewportHeight] = React.useState<number>()
  const columnVisibility = { ...settings.columnVisibility, __select: true, ...(columnIds?.[0] ? { [columnIds[0]]: true } : {}), ...Object.fromEntries(actionColumnIds.map(id => [id, true])) }
  const columnSizing = settings.columnSizing
  const setColumnVisibility: React.Dispatch<React.SetStateAction<VisibilityState>> = change => onSettingsChange(current => ({ ...current, columnVisibility: typeof change === "function" ? change(current.columnVisibility) : change }))
  const setColumnSizing: React.Dispatch<React.SetStateAction<ColumnSizingState>> = change => onSettingsChange(current => ({ ...current, columnSizing: typeof change === "function" ? change(current.columnSizing) : change }))
  const orderStore = columnOrderStore ?? tableView.columnOrderStore
  const savedOrder = React.useSyncExternalStore(orderStore.subscribe, orderStore.getSnapshot, orderStore.getServerSnapshot)
  React.useEffect(() => { columnOrderStore?.load() }, [columnOrderStore])
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const columns = [
    { id: "__select", size: selectionColumnWidth, minSize: selectionColumnWidth, maxSize: selectionColumnWidth, enableResizing: false },
    ...widths.map((size, index) => ({
      id: columnIds?.[index] ?? `column-${index}`,
      size: index === widths.length - 1
        ? Math.max(size, viewportWidth - selectionColumnWidth - widths.slice(0, -1).reduce((sum, width, i) => sum + (columnSizing[columnIds?.[i] ?? `column-${i}`] ?? width), 0))
        : size,
      minSize: 80, maxSize: 1200,
      enableResizing: !actionColumnIds.includes(columnIds?.[index] ?? `column-${index}`),
      enableHiding: !actionColumnIds.includes(columnIds?.[index] ?? `column-${index}`),
    })),
  ]
  const sourceIds = columns.map(column => column.id)
  const columnOrder = resolveCollectionColumnOrder(sourceIds, reorderable ? savedOrder : [], actionColumnIds)
  const table = useReactTable({
    data: EMPTY_DATA, columns, getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange", state: { columnSizing, columnVisibility, columnOrder }, onColumnSizingChange: setColumnSizing, onColumnVisibilityChange: setColumnVisibility,
  })
  const measureViewport = React.useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    setViewportWidth(viewport.clientWidth)
    setViewportHeight(Math.max(200, window.innerHeight - Math.max(0, viewport.getBoundingClientRect().top) - 24))
    setHeaderHeight(headRef.current?.getBoundingClientRect().height ?? 50)
  }, [])
  // A sibling can move this viewport without resizing it (Details/Compare).
  // Measure its position after every layout commit, not just its own resize.
  React.useLayoutEffect(measureViewport)
  React.useEffect(() => {
    const observer = new ResizeObserver(measureViewport)
    const onScroll = (event: Event) => {
      if (event.target === document || (event.target instanceof Element && event.target.contains(scrollRef.current))) measureViewport()
    }
    window.addEventListener("resize", measureViewport)
    window.addEventListener("scroll", onScroll, true)
    if (scrollRef.current) observer.observe(scrollRef.current)
    if (headRef.current) observer.observe(headRef.current)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measureViewport)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [view, measureViewport])
  const leafColumns = table.getAllLeafColumns()
  const total = table.getTotalSize()
  const visibleColumns = leafColumns.filter(column => column.getIsVisible())
  const visibleIndices = visibleColumns.map(column => sourceIds.indexOf(column.id))
  const movableIds = visibleColumns.filter(column => column.id !== "__select" && !actionColumnIds.includes(column.id)).map(column => column.id)
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!reorderable || !over || active.id === over.id) return
    if (!movableIds.includes(String(active.id)) || !movableIds.includes(String(over.id))) return
    orderStore.set(arrayMove(columnOrder, columnOrder.indexOf(String(active.id)), columnOrder.indexOf(String(over.id))))
  }
  const labels: string[] = []
  const headers: React.ReactNode[] = []
  function labelText(node: React.ReactNode): string {
    if (typeof node === "string") return node
    if (Array.isArray(node)) return node.map(labelText).find(Boolean) ?? ""
    if (React.isValidElement<React.PropsWithChildren>(node)) return labelText(React.Children.toArray(node.props.children)[0])
    return ""
  }
  function collectLabels(node: React.ReactNode) {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<React.PropsWithChildren>(child)) return
      if (child.type === "th") {
        labels.push((child.props as React.ThHTMLAttributes<HTMLTableCellElement>)["aria-label"] || labelText(child.props.children))
        headers.push(child.props.children)
      }
      else if (child.type === "thead" || child.type === "tr") collectLabels(child.props.children)
    })
  }
  collectLabels(children)
  const webColumns = JSON.stringify(sourceIds.filter(id => id !== "__select" && !actionColumnIds.includes(id)).map(id => ({ id, name: labels[sourceIds.indexOf(id)] || id })))
  const webLayout = React.useMemo(() => ({ order: orderStore, getColumns: () => JSON.parse(webColumns) }), [orderStore, webColumns])
  useColumnWebMcp(computedColumnStore ?? (automaticFields ? tableView.computed.store : undefined), !!computedColumnStore || automaticFields, webLayout)
  // Add handles to the existing semantic headers; pages keep their custom summaries.
  function decorate(node: React.ReactNode): React.ReactNode {
    return React.Children.map(node, (child) => {
      if (!React.isValidElement<React.HTMLAttributes<HTMLElement>>(child)) return child
      if (child.type === "thead") {
        const decorateHeaders = (content: React.ReactNode): React.ReactNode => React.Children.map(content, (row) => {
          if (!React.isValidElement<React.HTMLAttributes<HTMLElement>>(row) || row.type !== "tr") return row
          const headers = React.Children.toArray(row.props.children)
          return React.cloneElement(row, {}, visibleColumns.map(column => {
            const sourceIndex = sourceIds.indexOf(column.id)
            const item = headers[sourceIndex]
            if (!React.isValidElement<React.ComponentPropsWithRef<"th">>(item)) return null
            const header = table.getFlatHeaders().find(entry => entry.column.id === column.id)
            const element = React.cloneElement(item, { className: cn(item.props.className, "relative") }, <>
              {item.props.children}
              {column.getCanResize() && header ? <div
                role="separator" aria-orientation="vertical" aria-label={`Resize ${column.id}`}
                aria-valuenow={column.getSize()} aria-valuemin={80} aria-valuemax={1200} tabIndex={0}
                onMouseDown={event => { event.stopPropagation(); header.getResizeHandler()(event) }} onTouchStart={event => { event.stopPropagation(); header.getResizeHandler()(event) }}
                onDoubleClick={() => column.resetSize()}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                  event.preventDefault()
                  table.setColumnSizing((current) => ({ ...current, [column.id]: Math.max(80, Math.min(1200, column.getSize() + (event.key === "ArrowRight" ? 16 : -16))) }))
                }}
                className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize touch-none select-none hover:bg-ring focus-visible:bg-ring focus-visible:outline-none"
              /> : null}
            </>)
            const position = movableIds.indexOf(column.id)
            const move = (offset: number) => () => orderStore.set(arrayMove(columnOrder, columnOrder.indexOf(column.id), columnOrder.indexOf(movableIds[position + offset])))
            const targets = (selectedHeaders.has(column.id) ? movableIds.filter(id => selectedHeaders.has(id)) : [column.id]).filter(id => id !== sourceIds[1])
            const menu = displayControls && position >= 0 ? {
              count: targets.length,
              hide: targets.length ? () => {
                setColumnVisibility(current => ({ ...current, ...Object.fromEntries(targets.map(id => [id, false])) }))
                setSelectedHeaders(new Set())
              } : undefined,
              left: reorderable && position > 0 ? move(-1) : undefined,
              right: reorderable && position < movableIds.length - 1 ? move(1) : undefined,
            } : undefined
            return <SortableCollectionHeader selected={!!menu && selectedHeaders.has(column.id)} onSelectHeader={additive => setSelectedHeaders(current => {
              if (!additive) return new Set(current.size === 1 && current.has(column.id) ? [] : [column.id])
              const next = new Set(current)
              if (next.has(column.id)) next.delete(column.id)
              else next.add(column.id)
              return next
            })} menu={menu} key={column.id} id={column.id} label={labels[sourceIndex] || column.id} enabled={reorderable && movableIds.includes(column.id)} element={element} />
          }))
        })
        return <thead key={child.key} ref={node => { headRef.current = node }} className={cn(child.props.className, "sticky top-0 z-10")}>{decorateHeaders(child.props.children)}</thead>
      }
      return child
    })
  }
  const actionIndices = actionColumnIds.map(id => sourceIds.indexOf(id))
  const selectionToolbar = <div ref={view === "cards" ? node => { headRef.current = node } : undefined} className={cn("flex min-h-12 items-center justify-between gap-3 bg-surface-canvas px-3 py-2 text-sm text-muted-foreground", view === "cards" && "sticky top-0 z-10", selectionToolbarClassName)}>
    <div className="flex items-center gap-3">{view === "cards" && hasSelectionControl(headers[0]) ? <label className="flex cursor-pointer items-center gap-2">{headers[0]}<span>Select all</span></label> : null}{selectionActions}</div>
    {view === "cards" ? actionIndices.map(index => <React.Fragment key={sourceIds[index]}>{headers[index]}</React.Fragment>) : null}
  </div>
  return <CollectionTableContext.Provider value={{ extraFields: automaticFields ? { columns: fieldColumns, cells: fieldCells } : undefined, rowHeight, animateRows, appearedRows, scrollRef, headerHeight, columnCount: visibleColumns.length, visibleIndices, view, headers, actionIndices, sourceIds, labels, reorderable, onDragEnd }}>
    {!controlledSettings && tableView.savedView && <CustomViewControls {...tableView.savedView} />}
    {!controlledSettings && tableView.storageError ? <Notice variant="error" role="status">{tableView.storageError}</Notice> : null}
    {displayControls || enableCardView || enableRowHeight ? <HeaderDisplay settings={displaySettings} rowHeight={rowHeight} onRowHeightChange={setRowHeight} view={enableCardView ? view : undefined} onViewChange={setView} columns={displayControls ? leafColumns.slice(1).map((column) => ({ id: column.id, label: labels[sourceIds.indexOf(column.id)] || column.id, visible: column.getIsVisible(), disabled: column.id === sourceIds[1] })).filter(column => !actionColumnIds.includes(column.id)) : []} onChange={(id, visible) => table.getColumn(id)?.toggleVisibility(visible)} /> : null}
    {view === "table" && selectionActions ? selectionToolbar : null}
    <DndContext id={React.useId()} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
    <SortableContext items={reorderable ? movableIds : []} strategy={horizontalListSortingStrategy}>
    <div ref={scrollRef} tabIndex={0} aria-label={view === "cards" ? "Collection cards scroll area" : "Collection table scroll area"} className={cn("collection-table-scroll relative overflow-auto", fillHeight && "min-h-0 flex-1")} style={{ height: fillHeight ? "100%" : undefined, maxHeight: fillHeight ? "none" : viewportHeight ?? "calc(100dvh - 12rem)" }}>
      {view === "cards" ? <>
        {selectionToolbar}
        {React.Children.map(children, child => {
          if (!React.isValidElement<React.HTMLAttributes<HTMLElement>>(child)) return child
          if (child.type === "thead") return null
          if (child.type === "caption") return <div {...child.props} />
          return child
        })}
      </> : <table className={collectionTable.table} style={{ width: total }}>
        <colgroup>{leafColumns.filter(column => column.getIsVisible()).map((column) => <col key={column.id} style={{ width: column.getSize() }} />)}</colgroup>
        {decorate(children)}
      </table>}
      {pagination ? <InfiniteScroll {...pagination} /> : null}
    </div>
    </SortableContext>
    </DndContext>
  </CollectionTableContext.Provider>
}

/** Render only visible rows; ResizeObserver measures tall JSON rows after resizing. */
export function CollectionTableBody<T extends { id: string }>({ rows, children, empty, estimatedRowHeight = 42, renderComparison }: {
  rows: T[]
  children: (row: T, index: number) => React.ReactElement<React.ComponentProps<typeof CollectionRow>>
  empty?: React.ReactNode
  renderComparison?: (row: T, index: number) => React.ReactElement<React.ComponentProps<typeof CollectionRow>>
  estimatedRowHeight?: number
}) {
  const context = React.useContext(CollectionTableContext)
  if (!context) throw new Error("CollectionTableBody must be inside CollectionTable")
  const pairedTable = !!renderComparison && context.view === "table"
  const virtualizer = useVirtualizer({
    count: rows.length * (pairedTable ? 2 : 1),
    getScrollElement: () => context.scrollRef.current,
    getItemKey: (index) => pairedTable ? `${rows[Math.floor(index / 2)].id}:${index % 2}` : rows[index].id,
    estimateSize: () => context.view === "cards" ? Math.max(estimatedRowHeight, context.visibleIndices.length * 100) : estimatedRowHeight,
    overscan: 12,
    scrollMargin: context.headerHeight,
    gap: context.view === "cards" ? 12 : 2,
  })
  React.useEffect(() => {
    context.scrollRef.current?.scrollTo({ top: 0, left: 0 })
    virtualizer.measure()
  }, [context.view, context.rowHeight, context.scrollRef, virtualizer, pairedTable])
  const items = virtualizer.getVirtualItems()
  const top = items.length ? Math.max(0, items[0].start - context.headerHeight) : 0
  const bottom = items.length ? Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1].end - context.headerHeight)) : 0
  if (context.view === "cards") return <div className="space-y-3 text-sm">
    {top > 0 ? <div aria-hidden="true" style={{ height: Math.max(0, top - 12) }} /> : null}
    {items.map(item => renderComparison ? <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="grid grid-cols-2 items-stretch gap-3">
      {React.cloneElement(children(rows[item.index], item.index), { animationKey: `${item.key}:primary`, fieldRowId: rows[item.index].id })}
      {React.cloneElement(renderComparison(rows[item.index], item.index), { animationKey: `${item.key}:comparison`, fieldRowId: rows[item.index].id })}
    </div> : React.cloneElement(children(rows[item.index], item.index), {
      key: item.key, fieldRowId: rows[pairedTable ? Math.floor(item.index / 2) : item.index].id, animationKey: String(item.key), ref: virtualizer.measureElement, "data-index": item.index,
    } as React.ComponentProps<typeof CollectionRow>))}
    {bottom > 0 ? <div aria-hidden="true" style={{ height: Math.max(0, bottom - 12) }} /> : null}
    {!rows.length ? <div className="py-10 text-center text-muted-foreground">{unwrapTableCells(empty)}</div> : null}
  </div>
  return <tbody>
    {top > 0 ? <tr aria-hidden="true"><td colSpan={context.columnCount} style={{ height: top, padding: 0 }} /></tr> : null}
    {items.map((item) => {
      const index = pairedTable ? Math.floor(item.index / 2) : item.index
      const render = pairedTable && item.index % 2 === 1 ? renderComparison! : children
      return React.cloneElement(render(rows[index], index), {
        key: item.key, fieldRowId: rows[pairedTable ? Math.floor(item.index / 2) : item.index].id, animationKey: String(item.key), ref: virtualizer.measureElement, "data-index": item.index,
        "aria-rowindex": item.index + 2,
      } as React.ComponentProps<typeof CollectionRow>)
    })}
    {bottom > 0 ? <tr aria-hidden="true"><td colSpan={context.columnCount} style={{ height: bottom, padding: 0 }} /></tr> : null}
    {!rows.length ? empty : null}
  </tbody>
}

function unwrapTableCells(node: React.ReactNode): React.ReactNode {
  return React.Children.map(node, child => React.isValidElement<React.PropsWithChildren>(child) && ["tr", "td", "tbody"].includes(String(child.type)) ? unwrapTableCells(child.props.children) : child)
}

type CollectionRowProps = React.HTMLAttributes<HTMLElement> & { fieldRowId?: string; ref?: React.Ref<HTMLElement>; checked?: boolean; active?: boolean; rowLabel?: React.ReactNode; animationKey?: string }

export function CollectionRow({ checked = false, active = false, className, children, ref, rowLabel, animationKey, fieldRowId, ...props }: CollectionRowProps) {
  const context = React.useContext(CollectionTableContext)
  if (context?.extraFields && fieldRowId) children = [...React.Children.toArray(children), ...context.extraFields.columns.map(field => <td key={field.id} className={collectionTable.cell}><ComputedValue cell={context.extraFields!.cells[field.id]?.[fieldRowId]} format={field.format} /></td>), <td key="add-auto-field" />]
  const elementRef = React.useRef<HTMLElement | null>(null)
  const entryStarted = React.useRef(false)
  const fallbackKey = React.useId()
  const reducedMotion = useReducedMotion()
  const enabled = context?.animateRows ?? false
  const appearedRows = context?.appearedRows
  const entryKey = animationKey ?? fallbackKey
  React.useLayoutEffect(() => {
    const element = elementRef.current
    if (!enabled || !element || !appearedRows || (appearedRows.current.has(entryKey) && !entryStarted.current)) return
    entryStarted.current = true
    appearedRows.current.add(entryKey)
    if (reducedMotion) return
    const animation = animate(element, { opacity: [0, 1], transform: ["translateY(-6px)", "translateY(0px)"] }, { duration: 0.24, ease: "easeOut" })
    return () => {
      animation.stop()
      element.style.opacity = ""
      element.style.transform = ""
    }
  }, [enabled, appearedRows, entryKey, reducedMotion])
  const cells = React.Children.toArray(children)
  const setRef = (element: HTMLElement | null) => {
    elementRef.current = element
    if (typeof ref === "function") return ref(element)
    if (ref) ref.current = element
  }
  if (context?.view === "cards") return <article {...props} ref={setRef} data-selected={checked || active ? "true" : undefined} className={cn(collectionTable.row, "@container !h-auto overflow-hidden rounded-none border border-border", className)}>
    <div className="flex items-center gap-2">{React.isValidElement<React.PropsWithChildren>(cells[0]) && cells[0].type === "td" ? <div>{cells[0].props.children}</div> : cells[0]}{rowLabel ? <div className="min-w-0 py-3 pr-3 text-xs text-muted-foreground">{rowLabel}</div> : null}</div>
    <CollectionCardFields context={context} cells={cells} />
  </article>
  return <tr {...props} ref={setRef} data-selected={checked || active ? "true" : undefined} className={cn(collectionTable.row, context?.rowHeight === "compact" && collectionTable.compactRow, context?.rowHeight === "tall" && "h-auto [&>td]:h-auto [&>td]:py-3 [&>td]:align-top", className)}>{context ? context.visibleIndices.map(index => {
    const cell = cells[index]
    if (context.rowHeight !== "compact" || index === 0 || context.actionIndices.includes(index) || !React.isValidElement<React.ComponentProps<"td">>(cell) || cell.type !== "td") return cell
    return React.cloneElement(cell, {}, <div className={collectionTable.compactCellContent}>{cell.props.children}</div>)
  }) : cells}</tr>
}


function SortableCardField({ id, label, enabled, header, cell }: {
  id: string; label: string; enabled: boolean; header: React.ReactNode
  cell: React.ReactElement<React.ComponentProps<"td">>
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !enabled })
  return <div ref={setNodeRef} className={cn("min-w-0 px-3 py-4", isDragging && "relative z-20 bg-surface-canvas opacity-80 shadow-md")} style={{ transform: CSS.Translate.toString(transform), transition }}>
    <dt ref={setActivatorNodeRef} {...(enabled ? attributes : {})} {...(enabled ? listeners : {})} role="term" aria-label={enabled ? label : undefined}
      title={enabled ? "Drag to reorder. Or press Space, use arrow keys, then Space to drop." : undefined}
      className={cn("mb-2 text-sm font-normal text-muted-foreground", enabled && "touch-none select-none cursor-grab active:cursor-grabbing [&_button]:cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        // Labels reorder; nested editors retain their own keyboard action.
        event.stopPropagation()
        if (enabled && event.target === event.currentTarget && !event.defaultPrevented) listeners?.onKeyDown?.(event)
      }}>{header}</dt>
    <dd {...cell.props} className="m-0 min-w-0 whitespace-normal [overflow-wrap:anywhere] [&_.truncate]:whitespace-normal [&_.truncate]:break-words">{cell.props.children}</dd>
  </div>
}

function CollectionCardFields({ context, cells }: { context: CollectionTableContextValue; cells: React.ReactNode[] }) {
  const indices = context.visibleIndices.filter(index => index !== 0 && !context.actionIndices.includes(index))
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  // Every card repeats the column IDs. Isolate its drag targets so dragging a
  // label can only collide with fields in that card, then update shared order.
  return <DndContext id={React.useId()} sensors={sensors} collisionDetection={closestCenter} onDragEnd={context.onDragEnd}>
    <SortableContext items={context.reorderable ? indices.map(index => context.sourceIds[index]) : []} strategy={rectSortingStrategy}>
      <dl className="grid grid-cols-1 @min-[40rem]:grid-cols-2">
        {indices.map(index => {
          const cell = cells[index]
          if (!React.isValidElement<React.ComponentProps<"td">>(cell)) return null
          return <SortableCardField key={context.sourceIds[index]} id={context.sourceIds[index]} label={context.labels[index] || context.sourceIds[index]} enabled={context.reorderable} header={context.headers[index]} cell={cell} />
        })}
      </dl>
    </SortableContext>
  </DndContext>
}
