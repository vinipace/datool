"use client"

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import {
  CircleDashed,
  GripVertical,
  LayoutDashboard,
  Pencil,
  X,
} from "lucide-react"
import GridLayout, { useContainerWidth, type Layout } from "react-grid-layout"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Notice } from "@/components/ui/notice"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { PropsEditor } from "./props-editor"
import { cn } from "@/lib/utils"
import {
  createGridLayout,
  hasLayoutChanges,
  keyboardLayout,
  layoutChanges,
  stackGridLayout,
} from "./layout"
import type { CanvasProps, WidgetControls, WidgetPropsMap } from "./types"
import styles from "./canvas.module.css"

class WidgetBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false })
  }
  render() {
    return this.state.failed ? (
      <div className="p-4">
        <Notice
          variant="error"
          role="alert"
          title="This widget couldn't render."
        >
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => this.setState({ failed: false })}
          >
            Retry widget
          </Button>
        </Notice>
      </div>
    ) : (
      this.props.children
    )
  }
}

function WidgetLoading() {
  return (
    <div
      role="status"
      className="flex h-full min-h-24 items-center justify-center gap-2 text-sm text-foreground-muted"
    >
      <CircleDashed
        className="size-4 motion-safe:animate-spin"
        aria-hidden="true"
      />
      Loading widget
    </div>
  )
}

function AutoHeightContent({
  children,
  onHeight,
  enabled,
}: {
  children: ReactNode
  onHeight: (height: number) => void
  enabled: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const measure = () => onHeight(element.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeight, enabled])
  return (
    <div ref={ref} className={enabled ? "flow-root" : "h-full"}>
      {children}
    </div>
  )
}

function RemoveWidgetButton({
  label,
  onRemove,
  canvasRef,
}: {
  label: string
  onRemove: () => void
  canvasRef: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmedRef = useRef(false)

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) confirmedRef.current = false
        setOpen(nextOpen)
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen && confirmedRef.current) {
          onRemove()
          canvasRef.current?.focus()
        }
      }}
    >
      <AlertDialogTrigger
        render={
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            className="mr-2"
          />
        }
        data-canvas-no-drag
        aria-label={`Remove ${label}`}
      >
        <X className="size-3.5" />
      </AlertDialogTrigger>
      <AlertDialogContent
        size="sm"
        initialFocus={cancelRef}
        finalFocus={() =>
          !confirmedRef.current && triggerRef.current?.isConnected
            ? triggerRef.current
            : canvasRef.current
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Remove widget?</AlertDialogTitle>
          <AlertDialogDescription>
            “{label}” will be removed from this canvas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              confirmedRef.current = true
              setOpen(false)
            }}
          >
            Remove widget
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Controlled, JSON-driven dashboard grid. See README.md for the callback contract. */
export function Canvas<T extends WidgetPropsMap>({
  widgets,
  components,
  editors,
  onLayoutChange,
  onWidgetPropsChange,
  onWidgetRemove,
  getWidgetLabel = (widget) => widget.type,
  getWidgetAutoHeight,
  getWidgetInlineEditing,
  getWidgetFrameless,
  editable = true,
  widgetVariant = "outlined",
  columns: requestedColumns = 12,
  rowHeight = 60,
  gap = 12,
  stackBelow = 640,
  empty,
  className,
  contentClassName,
}: CanvasProps<T>) {
  const {
    width: canvasWidth,
    containerRef,
    measureWidth: measureCanvas,
  } = useContainerWidth({
    measureBeforeMount: true,
  })
  const {
    width,
    containerRef: gridRef,
    mounted,
    measureWidth: measureGrid,
  } = useContainerWidth({
    measureBeforeMount: true,
  })
  // Resolve the initial width before paint, including the stacked breakpoint.
  useLayoutEffect(() => {
    measureCanvas()
    measureGrid()
  }, [measureCanvas, measureGrid])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const editTriggerRef = useRef<HTMLButtonElement | null>(null)
  const editorPanelRef = useRef<HTMLElement>(null)
  const selected =
    editable && onWidgetPropsChange
      ? widgets.find(
          (widget) =>
            widget.id === selectedId && !getWidgetInlineEditing?.(widget)
        )
      : undefined
  if (selectedId !== null && !selected) setSelectedId(null)
  const panelId = useId()
  const vertical = canvasWidth < 720
  const closeEditor = useCallback(() => {
    setSelectedId(null)
    const target = editTriggerRef.current?.isConnected
      ? editTriggerRef.current
      : containerRef.current
    target?.focus()
  }, [containerRef])

  useEffect(() => {
    if (!selectedId) return
    editorPanelRef.current?.focus()
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      // Nested dialogs and menus get the first Escape, including removal confirmation.
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'
        )
      )
        return
      event.preventDefault()
      closeEditor()
    }
    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [selectedId, closeEditor])

  const Editor:
    | ComponentType<T[keyof T & string] & WidgetControls<T[keyof T & string]>>
    | undefined =
    selected && editors && Object.hasOwn(editors, selected.type)
      ? editors[selected.type]
      : undefined
  const instructionsId = useId()
  const columns = Number.isFinite(requestedColumns)
    ? Math.max(1, Math.round(requestedColumns))
    : 12
  const [contentHeights, setContentHeights] = useState<Record<string, number>>(
    {}
  )
  const layout = useMemo(
    () =>
      createGridLayout(
        widgets.map((widget) => {
          if (
            !getWidgetAutoHeight?.(widget) ||
            contentHeights[widget.id] === undefined
          )
            return widget
          const headerHeight = getWidgetFrameless?.(widget) ? 0 : 40
          // Grid heights include row gaps; frameless content has no title row.
          const h = Math.max(
            headerHeight ? 2 : 1,
            Math.ceil(
              (contentHeights[widget.id] + headerHeight + gap) /
                (rowHeight + gap)
            )
          )
          return {
            ...widget,
            layout: { ...widget.layout, h, minH: h, maxH: h },
          }
        }),
        columns
      ),
    [
      widgets,
      columns,
      getWidgetAutoHeight,
      getWidgetFrameless,
      contentHeights,
      gap,
      rowHeight,
    ]
  )
  const stacked = width < stackBelow
  const visibleLayout = useMemo(
    () => (stacked ? stackGridLayout(layout, columns) : layout),
    [stacked, layout, columns]
  )
  const canArrange = editable && !!onLayoutChange && !stacked

  function commit(next: Layout) {
    if (!canArrange) return
    if (
      getWidgetAutoHeight &&
      next.every((item) => {
        const visible = visibleLayout.find((current) => current.i === item.i)
        return (
          visible &&
          item.x === visible.x &&
          item.y === visible.y &&
          item.w === visible.w &&
          item.h === visible.h
        )
      })
    )
      return
    // Measured heights are a view concern, including at mobile widths. Keep the
    // user-controlled coordinates when the grid only reports content reflow.
    const changes = layoutChanges(widgets, next).map((change) => {
      const widget = widgets.find((item) => item.id === change.id)
      return widget && getWidgetAutoHeight?.(widget)
        ? { ...change, layout: { ...change.layout, h: widget.layout.h } }
        : change
    })
    if (hasLayoutChanges(widgets, changes)) onLayoutChange?.(changes)
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const delta = direction[event.key]
    if (!delta || !canArrange) return
    event.preventDefault()
    commit(keyboardLayout(layout, id, ...delta, event.shiftKey, columns))
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        styles.canvas,
        "flex h-full min-h-0 flex-1 flex-col outline-none",
        className
      )}
      tabIndex={-1}
      data-slot="canvas"
    >
      {canArrange && (
        <p id={instructionsId} className="sr-only">
          Drag to move. Use arrow keys to move one grid unit, or Shift and arrow
          keys to resize. Cards automatically close gaps.
        </p>
      )}
      <ResizablePanelGroup
        orientation={selected && vertical ? "vertical" : "horizontal"}
        className={cn(
          "min-h-0 flex-1",
          selected && "rounded-xl border border-border"
        )}
      >
        <ResizablePanel
          id={`${panelId}-canvas`}
          defaultSize="70%"
          minSize={selected ? "30%" : 0}
        >
          <div
            tabIndex={0}
            aria-label="Dashboard widgets"
            className={cn(
              "h-full overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring",
              selected && "p-3"
            )}
          >
            <div
              className={cn(widgets.length === 0 && "h-full", contentClassName)}
            >
              <div
                ref={gridRef}
                className={cn(
                  "min-w-0",
                  canArrange && widgets.length > 0 && "pb-[100dvh]",
                  widgets.length === 0 && "flex h-full flex-col"
                )}
              >
                {widgets.length === 0 ? (
                  (empty ?? (
                    <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-foreground-muted">
                      <LayoutDashboard className="size-6" aria-hidden="true" />
                      <p className="text-sm">
                        {editable
                          ? "Add a widget to start arranging your canvas."
                          : "No widgets to display."}
                      </p>
                    </div>
                  ))
                ) : !mounted ? (
                  <WidgetLoading />
                ) : (
                  <>
                    <GridLayout
                      width={width}
                      layout={visibleLayout}
                      className={styles.grid}
                      gridConfig={{
                        cols: columns,
                        rowHeight,
                        margin: [gap, gap],
                        containerPadding: [0, 0],
                      }}
                      dragConfig={{
                        enabled: canArrange,
                        handle: ".canvas-drag-header",
                        cancel: "[data-canvas-no-drag]",
                      }}
                      resizeConfig={{
                        enabled: canArrange,
                        handles: ["se", "sw", "ne", "nw"],
                      }}
                      onLayoutChange={commit}
                    >
                      {widgets.map((widget) => {
                        const label = getWidgetLabel(widget)
                        const frameless = !!getWidgetFrameless?.(widget)
                        const Widget:
                          | ComponentType<
                              T[keyof T & string] &
                                WidgetControls<T[keyof T & string]>
                            >
                          | undefined = Object.hasOwn(components, widget.type)
                          ? components[widget.type]
                          : undefined
                        return (
                          <div
                            key={widget.id}
                            data-widget-id={widget.id}
                            className={cn(
                              "group flex min-h-0 flex-col rounded-xl transition-colors",
                              frameless ? "bg-transparent" : "bg-muted",
                              frameless && editable && "hover:bg-muted",
                              !frameless &&
                                widgetVariant === "outlined" &&
                                "border border-border focus-within:border-selection-control",
                              selectedId === widget.id &&
                                (widgetVariant === "outlined"
                                  ? "border-selection-control"
                                  : "ring-1 ring-selection-control ring-inset")
                            )}
                          >
                            {(!frameless || editable) && (
                              <div
                                className={cn(
                                  "flex shrink-0 items-center gap-1",
                                  frameless
                                    ? "absolute top-2 right-2 z-10 h-8 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                                    : "h-10",
                                  canArrange &&
                                    "canvas-drag-header cursor-grab touch-none active:cursor-grabbing"
                                )}
                              >
                                {canArrange ? (
                                  <Button
                                    type="button"
                                    variant="ghost-muted"
                                    size={frameless ? "icon-sm" : "default"}
                                    className={cn(
                                      "cursor-grab active:cursor-grabbing",
                                      !frameless &&
                                        "h-full min-w-0 flex-1 justify-start rounded-none rounded-tl-xl px-3 text-sm"
                                    )}
                                    aria-label={`Move ${label}`}
                                    aria-describedby={instructionsId}
                                    onKeyDown={(event) =>
                                      handleKey(event, widget.id)
                                    }
                                  >
                                    {frameless ? (
                                      <GripVertical className="size-4" />
                                    ) : (
                                      <span className="truncate">{label}</span>
                                    )}
                                  </Button>
                                ) : !frameless ? (
                                  <span className="min-w-0 flex-1 truncate px-3 text-sm font-medium text-foreground-muted">
                                    {label}
                                  </span>
                                ) : null}
                                {editable &&
                                  onWidgetPropsChange &&
                                  !getWidgetInlineEditing?.(widget) && (
                                    <Button
                                      type="button"
                                      variant="ghost-muted"
                                      size="icon-sm"
                                      className={cn(!onWidgetRemove && "mr-2")}
                                      data-canvas-no-drag
                                      aria-label={`Edit ${label}`}
                                      aria-expanded={selectedId === widget.id}
                                      aria-controls={
                                        selectedId === widget.id
                                          ? panelId
                                          : undefined
                                      }
                                      onClick={(event) => {
                                        editTriggerRef.current =
                                          event.currentTarget
                                        setSelectedId(widget.id)
                                      }}
                                    >
                                      <Pencil className="size-3.5" />
                                    </Button>
                                  )}
                                {editable && onWidgetRemove && (
                                  <RemoveWidgetButton
                                    label={label}
                                    onRemove={() => onWidgetRemove(widget.id)}
                                    canvasRef={containerRef}
                                  />
                                )}
                              </div>
                            )}
                            <div className="min-h-0 flex-1 overflow-auto rounded-b-xl">
                              <AutoHeightContent
                                enabled={!!getWidgetAutoHeight?.(widget)}
                                onHeight={(height) => {
                                  if (!getWidgetAutoHeight?.(widget)) return
                                  setContentHeights((current) =>
                                    current[widget.id] === height
                                      ? current
                                      : { ...current, [widget.id]: height }
                                  )
                                }}
                              >
                                <WidgetBoundary
                                  resetKey={JSON.stringify([
                                    widget.type,
                                    widget.props,
                                  ])}
                                >
                                  <Suspense fallback={<WidgetLoading />}>
                                    {Widget ? (
                                      <Widget
                                        {...widget.props}
                                        editable={
                                          editable && !!onWidgetPropsChange
                                        }
                                        onPropsChange={(patch) => {
                                          if (editable)
                                            onWidgetPropsChange?.(widget.id, {
                                              ...widget.props,
                                              ...patch,
                                            })
                                        }}
                                      />
                                    ) : (
                                      <div className="p-4">
                                        <Notice
                                          variant="warning"
                                          role="alert"
                                          title="Unknown widget type"
                                        >
                                          No component is registered for “
                                          {widget.type}”.
                                        </Notice>
                                      </div>
                                    )}
                                  </Suspense>
                                </WidgetBoundary>
                              </AutoHeightContent>
                            </div>
                          </div>
                        )
                      })}
                    </GridLayout>
                  </>
                )}
              </div>
            </div>
          </div>
        </ResizablePanel>
        {selected && (
          <>
            <ResizableHandle
              withHandle
              aria-label="Resize widget configuration"
            />
            <ResizablePanel
              id={`${panelId}-configuration`}
              defaultSize={vertical ? "50%" : "30%"}
              minSize={vertical ? "35%" : "280px"}
            >
              <aside
                ref={editorPanelRef}
                id={panelId}
                tabIndex={-1}
                aria-label="Widget configuration"
                className="flex h-full min-w-0 flex-col bg-background outline-none"
              >
                <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
                  <WidgetBoundary
                    key={`${selected.id}:${selected.type}`}
                    resetKey={JSON.stringify(selected.props)}
                  >
                    <Suspense fallback={<WidgetLoading />}>
                      {Editor ? (
                        <Editor
                          {...selected.props}
                          editable
                          onPropsChange={(patch) =>
                            onWidgetPropsChange?.(selected.id, {
                              ...selected.props,
                              ...patch,
                            })
                          }
                        />
                      ) : (
                        <PropsEditor
                          value={selected.props}
                          onChange={(props) =>
                            onWidgetPropsChange?.(selected.id, props)
                          }
                        />
                      )}
                    </Suspense>
                  </WidgetBoundary>
                </div>
              </aside>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
