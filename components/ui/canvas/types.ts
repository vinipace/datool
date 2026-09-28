import type { ComponentType, ReactNode } from "react"

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type WidgetPropsMap = Record<string, Record<string, JsonValue>>

/** Coordinates and sizes are grid units, not pixels. */
export type WidgetLayout = {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
  maxW?: number
  maxH?: number
}

export type CanvasWidget<T extends WidgetPropsMap = WidgetPropsMap> = {
  [K in keyof T & string]: {
    id: string
    type: K
    props: T[K]
    layout: WidgetLayout
  }
}[keyof T & string]

/** Runtime controls are injected separately from the serializable widget props. */
export type WidgetControls<P> = {
  editable: boolean
  onPropsChange: (patch: Partial<P>) => void
}

export type WidgetComponents<T extends WidgetPropsMap> = {
  [K in keyof T]: ComponentType<T[K] & WidgetControls<T[K]>>
}

/** Optional configuration forms, with the same props and patch control as widgets. */
export type WidgetEditors<T extends WidgetPropsMap> = Partial<
  WidgetComponents<T>
>

export type CanvasLayoutChange = { id: string; layout: WidgetLayout }

export type CanvasProps<T extends WidgetPropsMap> = {
  widgets: readonly CanvasWidget<T>[]
  components: WidgetComponents<T>
  /** Missing editors fall back to a JSON props editor. */
  editors?: WidgetEditors<T>
  onLayoutChange?: (layout: CanvasLayoutChange[]) => void
  /** Receives the full next props object, after merging a widget's patch. */
  onWidgetPropsChange?: (id: string, props: T[keyof T]) => void
  onWidgetRemove?: (id: string) => void
  getWidgetLabel?: (widget: CanvasWidget<T>) => string
  /** Content-sized widgets grow and shrink without changing the saved arrangement. */
  getWidgetAutoHeight?: (widget: CanvasWidget<T>) => boolean
  /** Inline editors bypass the optional configuration panel. */
  getWidgetInlineEditing?: (widget: CanvasWidget<T>) => boolean
  /** Hide the title and frame, with compact controls revealed on hover or focus. */
  getWidgetFrameless?: (widget: CanvasWidget<T>) => boolean
  /** False hides Edit/Remove and configuration, disables arranging, and blocks prop changes. */
  editable?: boolean
  /** Borderless cards retain their raised background and editor selection ring. */
  widgetVariant?: "outlined" | "borderless"
  columns?: number
  rowHeight?: number
  gap?: number
  /** Below this container width, show a stacked preview without changing JSON. */
  stackBelow?: number
  empty?: ReactNode
  className?: string
  /** Styles the content inside the full-width scroll viewport. */
  contentClassName?: string
}
