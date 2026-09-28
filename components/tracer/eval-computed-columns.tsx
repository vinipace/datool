"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Combobox } from "@base-ui/react/combobox"
import { useFieldRegistry } from "./custom-field-registry"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { valueViews, valueViewLabels } from "@/src/lib/tracer/value-views"
import { objectTypes, type ViewObjectType } from "@/src/lib/tracer/view-resources"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useOverlayContainer } from "@/components/ui/overlay-container"
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core"
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { createColumnOrderStore, resolveLogColumnOrder } from "@/src/lib/tracer/log-column-order"
import { ChevronDown, Code2, Plus, X } from "lucide-react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { Button } from "@/components/ui/button"
import {
  columnRow,
  type ComputedCell,
  type ComputedColumn,
  type ComputedRow,
  type ComputedResource,
} from "@/src/lib/tracer/computed-columns"
import { JsonCode } from "./json-code"
import { useColumnValues } from "./use-computed-columns"
import { ColumnCodeEditor } from "./column-code-editor"
import { LogColumnEditorContext } from "./log-column-editor-context"
import { useTraceSectionDisclosure } from "./hooks"
import { useReviewAnnotations } from "./review-annotation-context"

export function ComputedValue({ cell, format }: { cell?: ComputedCell; format?: ComputedColumn["format"] }) {
  if (!cell) return <span className="text-muted-foreground">Evaluating…</span>
  if (cell.error)
    return (
      <span
        className="break-words whitespace-pre-wrap text-destructive"
        title={cell.error}
      >
        Error: {cell.error}
      </span>
    )
  if (cell.value == null)
    return <span className="text-empty-foreground">—</span>
  const value = typeof cell.value === "string" ? cell.value : JSON.stringify(cell.value, null, 2)
  if (format && format !== "markdown" && format !== "text") return <StructuredValueView value={cell.value} view={format} />
  if (format === "markdown") return <div className="text-sm break-words whitespace-normal [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:bg-surface-emphasis [&_pre]:p-2 [&_a]:underline"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown></div>
  return (
    <span className="break-words whitespace-pre-wrap tabular-nums">
      {value}
    </span>
  )
}

export function ColumnEditor({
  column,
  addedFields = [],
  addLabel = "Add Column",
  borderless = false,
  rows,
  resource = "eval",
  objectKind,
  onSave,
  onDelete,

}: {
  column?: ComputedColumn
  addedFields?: ComputedColumn[]
  borderless?: boolean
  addLabel?: string
  description?: string
  rows: ComputedRow[]
  resource?: ComputedResource
  objectKind?: ViewObjectType
  onSave: (column: ComputedColumn) => void
  onDelete?: () => void
}) {
  const fieldRegistry = useFieldRegistry()
  const overlayContainer = useOverlayContainer()
  const addTrigger = React.useRef<HTMLButtonElement>(null)
  const [open, setOpen] = React.useState(false)
  const [registered, setRegistered] = React.useState<ComputedColumn[]>([])
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [registryError, setRegistryError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [name, setName] = React.useState("")
  const [code, setCode] = React.useState("")
  const [format, setFormat] = React.useState<ComputedColumn["format"]>("text")
  const [mode, setMode] = React.useState<ComputedColumn["mode"]>("template")
  const [targets, setTargets] = React.useState<ViewObjectType[]>([])
  const [resultType, setResultType] = React.useState<ComputedColumn["resultType"]>("any")
  const [preview, setPreview] = React.useState<ComputedColumn | null>(null)
  const id = React.useId()
  const previewCells = useColumnValues(
    rows.slice(0, 1),
    preview ? [preview] : []
  )
  const previewCell =
    preview && rows[0] ? previewCells[preview.id]?.[rows[0].id] : undefined
  const draft = (): ComputedColumn => ({
    ...column,
    id: column?.id ?? crypto.randomUUID(),
    name: name.trim(),
    code,
    mode,
    format,
    objectTypes: targets.length ? targets : [objectKind ?? (resource === "dataset" ? "dataset-item" : "trace")],
    resultType,
  })
  const registerEditor = React.useContext(LogColumnEditorContext)
  const changeOpen = React.useCallback((value: boolean) => {
    if (value) {
      setRegistryError(null)
      // A legacy field import must not block the current project's library.
      void fieldRegistry.migrate().catch(() => {}).then(() => fieldRegistry.refresh()).then(setRegistered).catch(error => setRegistryError(String(error)))
      setName(column?.name ?? "")
      setCode(column?.code ?? (resource === "dataset" ? "{{row.input}}" : resource === "performance" ? "{{row.metrics.completedCount}}" : "R${{row.metrics.cost*5.5}}"))
      setMode(column?.mode ?? "template")
      setFormat(column?.format ?? "text")
      setTargets(column?.objectTypes ?? [objectKind ?? (resource === "dataset" ? "dataset-item" : resource === "performance" ? "agent" : "trace")])
      setResultType(column?.resultType ?? "any")
      setPreview(null)
    }
    setOpen(value)
  }, [column, resource, fieldRegistry, objectKind])
  React.useEffect(() => {
    if (!column || !registerEditor) return
    registerEditor(() => changeOpen(true))
    return () => registerEditor(null)
  }, [column, registerEditor, changeOpen])
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {column ? <DialogTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1.5 text-left hover:text-foreground" aria-label={`Edit column ${column.name}`}>
            {column.name}<Code2 className="size-3.5 shrink-0" />
          </button>
        </DialogTrigger> : <Combobox.Root<ComputedColumn> items={registered.filter(field => !addedFields.some(added => added.id === field.id))} value={null} open={pickerOpen} onOpenChange={value => {
          setPickerOpen(value)
          if (value) {
            setRegistryError(null)
            void fieldRegistry.migrate().catch(() => {}).then(() => fieldRegistry.refresh()).then(setRegistered).catch(error => setRegistryError(String(error)))
          }
        }} itemToStringLabel={field => field.name} onValueChange={field => {
          if (field) { onSave(field); setPickerOpen(false) }
        }}>
          <Combobox.Trigger ref={addTrigger} data-slot="combobox-trigger" aria-label={addLabel} render={<Button variant={borderless ? "ghost" : "outline"} size="sm" />}>
            <Plus className="size-3.5" />{addLabel}
          </Combobox.Trigger>
          <Combobox.Portal container={overlayContainer?.current ?? undefined}><Combobox.Positioner className="z-[90]" sideOffset={4} align="start">
            <Combobox.Popup data-slot="combobox-content" className="w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              <Combobox.Input data-slot="combobox-input" aria-label="Search custom fields" placeholder="Search custom fields…" className="w-full border-b bg-transparent px-3 py-2 text-sm outline-none" />
              {registryError && <p role="alert" className="p-2 text-sm text-destructive">{registryError}</p>}
              <Combobox.Empty className="p-2 text-sm text-muted-foreground">No matching fields.</Combobox.Empty>
              <Combobox.List className="max-h-64 overflow-y-auto">{(field: ComputedColumn) => <Combobox.Item key={field.id} value={field} className="cursor-pointer rounded px-3 py-2 text-sm data-highlighted:bg-muted">{field.name}</Combobox.Item>}</Combobox.List>
              <button type="button" className="flex w-full items-center gap-2 border-t px-3 py-2 text-sm hover:bg-muted" onClick={() => { setPickerOpen(false); changeOpen(true) }}><Plus className="size-4" />Create new custom field</button>
            </Combobox.Popup>
          </Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>}
        <DialogContent showCloseButton={false} onCloseAutoFocus={(event) => {
          if (!column) { event.preventDefault(); addTrigger.current?.focus() }
        }} className="z-[80] flex max-h-[90dvh] w-[min(800px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden bg-background p-6">
          <DialogTitle className="text-lg font-semibold">
            {column ? "Edit custom field" : "Add custom field"}
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            {column ? "Changes update this field everywhere it is used." : "Reuse a registered field or create one. Custom fields are shared across Datool; each table chooses which to show."}
          </DialogDescription>
          <DialogClose asChild><button
              type="button"
              aria-label="Close column editor"
              className="absolute top-4 right-4 rounded p-1 hover:bg-muted"
            >
              <X className="size-4" />
            </button></DialogClose>
          {registryError && <p role="alert" className="mt-3 text-sm text-destructive">{registryError}</p>}
          <form
            className="mt-4 min-h-0 space-y-3 overflow-y-auto"
            onSubmit={async (event) => {
              event.preventDefault()
              if (name.trim() && code.trim()) {
                setSaving(true)
                setRegistryError(null)
                try {
                  const saved = await fieldRegistry.save(draft(), !!column)
                  onSave(saved)
                  setOpen(false)
                } catch (error) { setRegistryError(error instanceof Error ? error.message : String(error)) }
                finally { setSaving(false) }
              }
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                Column name
              </label>
              <input
                id={`${id}-name`}
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={resource === "dataset" ? "Question" : resource === "performance" ? "Completed operations" : "Cost (BRL)"}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm">Display format<select aria-label="Display format" value={format} onChange={event => setFormat(event.target.value as ComputedColumn["format"])} className="block w-full border bg-background p-2">{valueViews.map(view => <option key={view} value={view}>{valueViewLabels[view]}</option>)}<option value="markdown">Markdown</option></select></label>
              <fieldset className="space-y-2"><legend className="text-sm font-medium">Supported objects</legend><div className="flex flex-wrap gap-3">{objectTypes.map(kind => <label key={kind} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={targets.includes(kind)} onChange={event => setTargets(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} />{kind}</label>)}</div></fieldset>
              <label className="block text-sm">Result type<select aria-label="Field result type" value={resultType} onChange={event => setResultType(event.target.value as ComputedColumn["resultType"])} className="block w-full border bg-background p-2">{["any", "string", "number", "boolean", "object", "array"].map(type => <option key={type} value={type}>{type}</option>)}</select></label>
              <label htmlFor={`${id}-mode`} className="text-sm font-medium">
                Format
              </label>
              <select
                id={`${id}-mode`}
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as ComputedColumn["mode"])
                  setPreview(null)
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="template">
                  Text template with {"{{ JavaScript }}"}
                </option>
                <option value="expression">JavaScript expression</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">
                {mode === "template" ? "Template" : "JavaScript expression"}
              </div>
              <ColumnCodeEditor
                value={code}
                mode={mode}
                rows={rows}
                resource={resource}
                onChange={(value) => {
                  setCode(value)
                  setPreview(null)
                }}
              />
              <p className="text-xs text-muted-foreground">
                {resource === "dataset"
                  ? mode === "template" ? "Example: {{row.input.question}}" : "Example: row.input.question"
                  : resource === "performance"
                  ? mode === "template" ? "Example: {{row.metrics.completedCount}}" : "Example: row.metrics.completedCount"
                  : mode === "template"
                  ? "Example: R${{(row.metrics.cost * 5.5).toFixed(4)}}"
                  : "Example: row.metrics.cost * 5.5"}
              </p>
            </div>
            {resource === "dataset" ? <p className="text-xs leading-5 text-foreground-muted">
              Use <code>row.input</code>, <code>row.expectedOutput</code>, or <code>row.metadata</code>, including nested fields. Computed values are read-only and do not change dataset items.
            </p> : resource === "performance" ? <p className="text-xs leading-5 text-foreground-muted">
              Use <code>row.name</code>, <code>row.groupType</code>, or <code>row.metrics</code>, including <code>row.metrics.versionCount</code>.
              Metrics aggregate operations in the selected time range. Durations are in milliseconds, costs in USD, and unavailable metrics are null.
            </p> : <p className="text-xs leading-5 text-muted-foreground">
              <code>row.metrics.cost</code> is the trace cost in USD, when
              available. Use <code>row.input</code>, <code>row.output</code>,{" "}
              <code>row.expectedOutput</code>, <code>row.results</code>, or{" "}
              <code>row.trace</code> for other data.
            </p>}
            <div className="rounded-md border border-border p-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!rows.length || !code.trim()}
                onClick={() => setPreview(draft())}
              >
                Preview first row
              </Button>
              <div className="mt-2 text-sm" aria-live="polite">
                {preview ? (
                  <ComputedValue format={format} cell={previewCell} />
                ) : (
                  <span className="text-muted-foreground">
                    {rows.length
                      ? "Preview your formula before saving."
                      : "No rows available to preview yet."}
                  </span>
                )}
              </div>
            </div>
            {rows[0] ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Available row data
                </summary>
                <pre className="mt-2 max-h-52 overflow-auto rounded-md bg-muted/30 p-3 break-words whitespace-pre-wrap">
                  <JsonCode
                    text={JSON.stringify(columnRow(rows[0]), null, 2)}
                  />
                </pre>
              </details>
            ) : null}
            <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background py-3">
              {onDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    onDelete()
                    setOpen(false)
                  }}
                >
                  Remove from this table
                </Button>
              ) : null}
              <div className="flex-1" />
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saving || !name.trim() || !code.trim()}>
                {column ? "Save changes" : "Add column"}
              </Button>
            </div>
          </form>
        </DialogContent>
    </Dialog>
  )
}


export function ComputedColumnDetails({ columns, cells, rowId, action, onRemove, renderValue }: { onRemove: (id: string) => void; action?: React.ReactNode; columns: ComputedColumn[]; cells: Record<string, Record<string, ComputedCell>>; rowId: string; renderValue?: (column: ComputedColumn, cell?: ComputedCell) => React.ReactNode }) {
  const focus = useReviewAnnotations()?.focus?.reference
  const store = React.useMemo(() => createColumnOrderStore("datool:custom-field-section-order"), [])
  const saved = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  React.useEffect(() => { store.load() }, [store])
  const order = resolveLogColumnOrder(columns.map(column => column.id), saved)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
    // Keep Enter available for the disclosure; Space starts keyboard reordering.
    keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] },
  }))
  const dndId = React.useId()
  const suppressDragClick = React.useRef(false)
  if (!columns.length && !action) return null
  return <div onPointerDownCapture={() => { suppressDragClick.current = false }} onClickCapture={event => {
    if (suppressDragClick.current) {
      event.preventDefault()
      event.stopPropagation()
      suppressDragClick.current = false
    }
  }}>
    <DndContext id={dndId} sensors={sensors} onDragStart={() => { suppressDragClick.current = true }} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (!over || active.id === over.id) return
      const next = arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))
      store.set([...next, ...saved.filter(id => !next.includes(id))])
    }}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        {order.map((id, index) => {
          const column = columns.find(column => column.id === id)!
          return <SortableFieldSection key={id} initiallyRevealed={focus?.traceId === rowId && focus?.customField?.id === id} column={column} cell={cells[id]?.[rowId]} renderValue={renderValue} onRemove={() => onRemove(id)} canMoveUp={index > 0} canMoveDown={index < order.length - 1} onMove={delta => {
            const next = arrayMove(order, index, index + delta)
            store.set([...next, ...saved.filter(id => !next.includes(id))])
          }} />
        })}
      </SortableContext>
    </DndContext>
    {action && <div className="border-t border-white/[0.18] [&_button]:h-auto [&_button]:w-full [&_button]:justify-start [&_button]:rounded-none [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-0 [&_button]:py-3 [&_button]:shadow-none">{action}</div>}
  </div>
}

function SortableFieldSection({ column, cell, onRemove, onMove, canMoveUp, canMoveDown, renderValue, initiallyRevealed }: { column: ComputedColumn; cell?: ComputedCell; onRemove: () => void; onMove: (delta: number) => void; canMoveUp: boolean; canMoveDown: boolean; renderValue?: (column: ComputedColumn, cell?: ComputedCell) => React.ReactNode; initiallyRevealed?: boolean }) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const disclosure = useTraceSectionDisclosure(`custom-field:${column.id}`, initiallyRevealed)
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: column.id })
  return <ContextMenu onOpenChange={setMenuOpen}><ContextMenuTrigger asChild><details ref={setNodeRef} {...disclosure} style={{ transform: CSS.Translate.toString(transform), transition, position: "relative", zIndex: isDragging ? 1 : undefined }} className={`group border-t border-white/[0.18] ${menuOpen ? "bg-selection ring-1 ring-inset ring-ring/40" : "bg-background"}`}>
    <summary ref={setActivatorNodeRef} {...attributes} {...listeners} className="flex touch-none cursor-pointer list-none items-center justify-between gap-3 rounded-sm py-2 text-sm text-foreground-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <span className="flex min-w-0 cursor-grab items-center gap-2 active:cursor-grabbing">
        <Code2 className="size-4 shrink-0 text-foreground-subtle" />{column.name}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-foreground-muted">{column.format === "markdown" ? "Markdown" : "Text"}<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" /></span>
    </summary>
    <div className="min-w-0 pb-3 text-sm">{renderValue ? renderValue(column, cell) : <ComputedValue format={column.format} cell={cell} />}</div>
  </details></ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem disabled={!canMoveUp} onSelect={() => onMove(-1)}>Move up</ContextMenuItem>
      <ContextMenuItem disabled={!canMoveDown} onSelect={() => onMove(1)}>Move down</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRemove}>Remove custom field</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
}
