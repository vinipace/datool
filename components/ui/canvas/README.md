# Canvas

A controlled dashboard canvas with a widget registry, grid snapping, collision
reflow, automatic vertical compaction, and four resize corners. Its parent owns
the JSON and persistence. It has no document, database, query, or form dependencies.

Give the parent a defined height or a bounded flex layout. Canvas fills the
available space, including its configuration panel, and scrolls oversized widget
layouts inside the grid without growing the surrounding page.
Use `contentClassName` to constrain and center the grid (for example,
`"mx-auto w-full max-w-6xl p-3"`) while keeping the side margins scrollable.

```tsx
import { Canvas, findWidgetSpace, type CanvasWidget } from "@/components/ui/canvas"

type Widgets = {
  SimpleCard: { title: string; value: number }
  LineChart: { title: string; period: string }
}

const [widgets, setWidgets] = useState<CanvasWidget<Widgets>[]>([
  { id: "requests", type: "SimpleCard", props: { title: "Requests", value: 42 },
    layout: { x: 0, y: 0, w: 4, h: 3, minW: 3, minH: 2 } },
])

<Canvas
  widgets={widgets}
  components={{ SimpleCard, LineChart }}
  editors={{ SimpleCard: SimpleCardEditor, LineChart: LineChartEditor }}
  getWidgetLabel={(widget) => widget.props.title}
  onLayoutChange={(changes) => {
    const layouts = new Map(changes.map(({ id, layout }) => [id, layout]))
    setWidgets((current) => current.map((widget) => ({
      ...widget, layout: layouts.get(widget.id) ?? widget.layout,
    })))
  }}
  onWidgetPropsChange={(id, props) => {
    setWidgets((current) => current.map((widget) =>
      widget.id === id ? { ...widget, props } as CanvasWidget<Widgets> : widget
    ))
  }}
  onWidgetRemove={(id) => setWidgets((current) => current.filter((w) => w.id !== id))}
/>
```

- `widgets` contains unique stable IDs, registered type names, serializable props,
  and `{ x, y, w, h }` in grid units. Optional `minW/minH/maxW/maxH` constrain size.
  The host should validate imported JSON and widget-specific props.
- Widgets receive their props directly plus `editable` and
  `onPropsChange(patch)`. These two names are reserved runtime controls. The canvas
  merges patches and calls `onWidgetPropsChange(id, fullNextProps)`.
- The Edit button opens a resizable configuration panel beside the canvas (below
  it on narrow screens). `editors` maps widget types to configuration components;
  each receives the same props and `onPropsChange(patch)` control as its widget.
  Missing editors use a JSON object editor. Incomplete JSON stays local and never
  reaches the callback. Widget-specific validation belongs in the custom editor.
  Every valid edit emits `onWidgetPropsChange` immediately; the parent applies it
  to state and handles durable persistence. Escape closes
  configuration and returns focus to Edit. Removing the selected widget closes it.
  Resizing the split remeasures the grid without rewriting the desktop layout.
- `onLayoutChange` emits all `{ id, layout }` records after movement, resizing,
  or compaction (including adding/removing items). Constraints are preserved;
  grid-library fields do not leak into JSON. Reconcile callbacks into parent
  state to keep the component controlled.
- Add a widget by appending to the array. `findWidgetSpace(widgets, { w, h })`
  finds the first available space in the 12-column grid; pass a third argument
  when using a different column count.
- Defaults: 12 columns, 60px rows, 12px gaps. Container width is observed, so
  the canvas also responds to sidebar/panel resizing. Below `stackBelow` (640px),
  cards become a stacked preview; movement/resizing are disabled and desktop
  coordinates remain unchanged. Set `stackBelow={0}` to retain the editable grid
  at every width.
- Use `<Canvas editable={false} ... />` for read-only mode. It hides Edit and
  Remove, disables dragging and resizing, prevents widget prop callbacks, and
  closes any open configuration panel. Switching back to editable keeps the
  panel closed until a widget is selected again. Widgets receive `editable={false}`
  so their own forms can disable editing while charts remain viewable.
  Without `onLayoutChange`, movement and resizing are also disabled.
- Use `widgetVariant="borderless"` for raised cards without an outline. Selected
  editors retain a selection ring; the default `outlined` variant has a border.
- Drag anywhere on a card header to move it. Focus its title and use arrow keys
  to move; Shift + arrow keys resize. Edit/remove buttons and widget contents stay
  interactive without starting a drag.
- The remove button opens a Base UI alert dialog. Cancel (or Escape) keeps the
  widget; confirmation calls `onWidgetRemove` after the dialog closes. Focus starts
  on Cancel and returns to the trigger when removal is canceled.
- Each widget has an independent Suspense fallback and error boundary with retry.
  Unknown registry entries show an explicit fallback without breaking neighbors.

Run `bun run storybook` and open **UI → Canvas → Playground**. The story provides
sample charts/cards/notes, autosaving configuration forms, add/remove controls, and a live JSON editor for copying
and restoring layouts. Additional stories cover empty, read-only, narrow, loading,
failed, unknown, and interactive states. Sample data never calls product APIs.
Use the playground's **Read-only** switch to preview this mode, or open the
dedicated **Read Only** story.
