import { lazy, useState, type ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  Braces,
  Check,
  Copy,
  LayoutDashboard,
  Plus,
  RotateCcw,
} from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/ui/notice"
import { dashboardSeriesColor } from "@/components/tracer/dashboard-chart-style"
import { Canvas } from "./canvas"
import { createGridLayout, findWidgetSpace, layoutChanges } from "./layout"
import type {
  CanvasProps,
  CanvasWidget,
  WidgetComponents,
  WidgetControls,
  WidgetEditors,
} from "./types"

type DemoProps = {
  LineChart: { title: string; period: string }
  SimpleCard: {
    title: string
    value: number
    suffix: string
    description: string
  }
  Note: { title: string; text: string }
}

function LineChart({
  period,
  editable,
  onPropsChange,
}: DemoProps["LineChart"] & WidgetControls<DemoProps["LineChart"]>) {
  const values =
    period === "7d"
      ? [35, 48, 42, 65, 54, 78, 86]
      : [22, 32, 29, 46, 39, 51, 49, 63, 57, 75, 68, 89]
  return (
    <div className="flex h-full min-h-44 flex-col gap-4 px-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight">24,680</p>
          <p className="mt-1 text-xs text-foreground-muted">
            Sample events over time
          </p>
        </div>
        <div className="flex gap-1">
          {["7d", "30d"].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={value === period ? "outline" : "ghost-muted"}
              aria-pressed={value === period}
              disabled={!editable}
              onClick={() => onPropsChange({ period: value })}
            >
              {value}
            </Button>
          ))}
        </div>
      </div>
      <div
        className="min-h-0 flex-1"
        role="img"
        aria-label={`Sample event trend for ${period}`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minHeight={80}
          initialDimension={{ width: 320, height: 200 }}
        >
          <RechartsLineChart
            data={values.map((value, index) => ({ day: index + 1, value }))}
            margin={{ top: 5, right: 5, bottom: 0, left: -25 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <XAxis
              dataKey="day"
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--foreground-muted)", fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--foreground-muted)", fontSize: 11 }}
              tickCount={4}
            />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                borderColor: "var(--border)",
                borderRadius: 8,
                color: "var(--foreground)",
              }}
            />
            <Line
              type="monotone"
              dataKey="value"
              name="Events"
              stroke={dashboardSeriesColor(0)}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
            />
          </RechartsLineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function SimpleCard({
  value,
  suffix,
  description,
  editable,
  onPropsChange,
}: DemoProps["SimpleCard"] & WidgetControls<DemoProps["SimpleCard"]>) {
  return (
    <div className="flex h-full flex-col justify-between gap-3 px-4 pb-4">
      <div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {value.toLocaleString("en-US")}
          <span className="ml-1 text-lg text-foreground-muted">{suffix}</span>
        </p>
        <p className="mt-2 text-xs text-foreground-muted">{description}</p>
      </div>
      {editable && (
        <Button
          size="sm"
          variant="ghost-muted"
          className="self-start"
          onClick={() => onPropsChange({ value: value + 1 })}
        >
          <Plus className="size-3" />
          Increment value
        </Button>
      )}
    </div>
  )
}

function Note({
  text,
  editable,
  onPropsChange,
}: DemoProps["Note"] & WidgetControls<DemoProps["Note"]>) {
  return (
    <div className="h-full px-4 pb-4">
      <Textarea
        aria-label="Note text"
        className="h-full resize-none border-0 bg-transparent p-0 leading-6 focus-visible:ring-0"
        value={text}
        readOnly={!editable}
        onChange={(event) => onPropsChange({ text: event.target.value })}
      />
    </div>
  )
}

const components = {
  LineChart,
  SimpleCard,
  Note,
} satisfies WidgetComponents<DemoProps>

function EditorField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-2 text-xs font-medium">
      {label}
      {children}
    </label>
  )
}

function NumberInput({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState({ source: value, text: String(value) })
  if (draft.source !== value) setDraft({ source: value, text: String(value) })
  return (
    <Input
      type="number"
      step="any"
      value={draft.text}
      onChange={(event) => {
        const text = event.target.value
        const next = event.target.valueAsNumber
        setDraft({ source: Number.isFinite(next) ? next : value, text })
        if (Number.isFinite(next)) onChange(next)
      }}
    />
  )
}

function CardEditor({
  title,
  value,
  suffix,
  description,
  onPropsChange,
}: DemoProps["SimpleCard"] & WidgetControls<DemoProps["SimpleCard"]>) {
  return (
    <div className="space-y-4">
      <EditorField label="Title">
        <Input
          value={title}
          onChange={(event) => onPropsChange({ title: event.target.value })}
        />
      </EditorField>
      <EditorField label="Value">
        <NumberInput
          value={value}
          onChange={(next) => onPropsChange({ value: next })}
        />
      </EditorField>
      <EditorField label="Suffix">
        <Input
          value={suffix}
          onChange={(event) => onPropsChange({ suffix: event.target.value })}
        />
      </EditorField>
      <EditorField label="Description">
        <Textarea
          value={description}
          onChange={(event) =>
            onPropsChange({ description: event.target.value })
          }
        />
      </EditorField>
    </div>
  )
}

function ChartEditor({
  title,
  period,
  onPropsChange,
}: DemoProps["LineChart"] & WidgetControls<DemoProps["LineChart"]>) {
  return (
    <div className="space-y-4">
      <EditorField label="Title">
        <Input
          value={title}
          onChange={(event) => onPropsChange({ title: event.target.value })}
        />
      </EditorField>
      <EditorField label="Period">
        <Select
          value={period}
          onChange={(event) => onPropsChange({ period: event.target.value })}
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
      </EditorField>
    </div>
  )
}

function NoteEditor({
  title,
  text,
  onPropsChange,
}: DemoProps["Note"] & WidgetControls<DemoProps["Note"]>) {
  return (
    <div className="space-y-4">
      <EditorField label="Title">
        <Input
          value={title}
          onChange={(event) => onPropsChange({ title: event.target.value })}
        />
      </EditorField>
      <EditorField label="Text">
        <Textarea
          className="min-h-48"
          value={text}
          onChange={(event) => onPropsChange({ text: event.target.value })}
        />
      </EditorField>
    </div>
  )
}

const editors = {
  SimpleCard: CardEditor,
  LineChart: ChartEditor,
  Note: NoteEditor,
} satisfies WidgetEditors<DemoProps>
const initialWidgets: CanvasWidget<DemoProps>[] = [
  {
    id: "requests",
    type: "SimpleCard",
    props: {
      title: "Total requests",
      value: 24680,
      suffix: "",
      description: "Across all workflows · sample data",
    },
    layout: { x: 0, y: 0, w: 4, h: 3, minW: 3, minH: 3 },
  },
  {
    id: "latency",
    type: "SimpleCard",
    props: {
      title: "Average latency",
      value: 842,
      suffix: "ms",
      description: "Response time · sample data",
    },
    layout: { x: 4, y: 0, w: 4, h: 3, minW: 3, minH: 3 },
  },
  {
    id: "success",
    type: "SimpleCard",
    props: {
      title: "Success rate",
      value: 98.6,
      suffix: "%",
      description: "Completed requests · sample data",
    },
    layout: { x: 8, y: 0, w: 4, h: 3, minW: 3, minH: 3 },
  },
  {
    id: "trend",
    type: "LineChart",
    props: { title: "Request volume", period: "7d" },
    layout: { x: 0, y: 3, w: 8, h: 5, minW: 4, minH: 4 },
  },
  {
    id: "notes",
    type: "Note",
    props: {
      title: "Notes",
      text: "Make this canvas yours.\n\nDrag a card by its header. Pull any corner to resize it. Neighboring cards move out of the way.\n\nYou can edit this note directly, too.",
    },
    layout: { x: 8, y: 3, w: 4, h: 5, minW: 3, minH: 3 },
  },
]

const positionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  minW: z.number().int().positive().optional(),
  minH: z.number().int().positive().optional(),
  maxW: z.number().int().positive().optional(),
  maxH: z.number().int().positive().optional(),
})
const identity = { id: z.string().min(1), layout: positionSchema }
const widgetsSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({
        ...identity,
        type: z.literal("LineChart"),
        props: z.object({ title: z.string(), period: z.enum(["7d", "30d"]) }),
      }),
      z.object({
        ...identity,
        type: z.literal("SimpleCard"),
        props: z.object({
          title: z.string(),
          value: z.number(),
          suffix: z.string(),
          description: z.string(),
        }),
      }),
      z.object({
        ...identity,
        type: z.literal("Note"),
        props: z.object({ title: z.string(), text: z.string() }),
      }),
    ])
  )
  .refine(
    (widgets) =>
      new Set(widgets.map((widget) => widget.id)).size === widgets.length,
    "Widget IDs must be unique"
  )

function CanvasPlayground(args: CanvasProps<DemoProps>) {
  const [widgets, setWidgets] = useState<CanvasWidget<DemoProps>[]>(() => [
    ...args.widgets,
  ])
  const [newType, setNewType] = useState<keyof DemoProps>("LineChart")
  const [showJson, setShowJson] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [readOnlyPreview, setReadOnlyPreview] = useState(false)
  const editable = args.editable !== false && !readOnlyPreview
  const json = JSON.stringify(widgets, null, 2)

  function addWidget() {
    const template = initialWidgets.find((widget) => widget.type === newType)!
    const layout = findWidgetSpace(widgets, template.layout, args.columns)
    setWidgets((current) => [
      ...current,
      {
        ...template,
        id: crypto.randomUUID(),
        props: { ...template.props },
        layout: { ...template.layout, ...layout },
      } as CanvasWidget<DemoProps>,
    ])
  }

  function applyJson() {
    try {
      setWidgets(widgetsSchema.parse(JSON.parse(draft ?? json)))
      setDraft(null)
      setError("")
    } catch (cause) {
      setError(
        cause instanceof z.ZodError
          ? cause.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "Widgets"}: ${issue.message}`
              )
              .join("; ")
          : "Enter valid JSON before applying the layout."
      )
    }
  }

  return (
    <main className="flex h-dvh flex-col bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted">
              <LayoutDashboard className="size-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Canvas playground
              </h1>
              <p className="mt-1 text-xs text-foreground-muted">
                Arrange your widgets. The layout follows.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost-muted"
              size="sm"
              disabled={!editable}
              onClick={() => {
                setWidgets([...args.widgets])
                setDraft(null)
                setError("")
              }}
            >
              <RotateCcw />
              Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showJson}
              onClick={() => setShowJson(!showJson)}
            >
              <Braces />
              Layout JSON
            </Button>
          </div>
        </header>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <p className="text-xs text-foreground-muted">
            {widgets.length} widgets <span aria-hidden="true">·</span>{" "}
            {!editable ? "Preview mode" : "Drag to move · corners to resize"}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-foreground-muted">
              <Switch
                checked={!editable}
                disabled={args.editable === false}
                onCheckedChange={setReadOnlyPreview}
              />
              Read-only
            </label>
            {editable && (
              <div className="flex gap-2">
                <Select
                  aria-label="Widget type"
                  className="h-8 w-36"
                  value={newType}
                  onChange={(event) =>
                    setNewType(event.target.value as keyof DemoProps)
                  }
                >
                  <option value="LineChart">Line chart</option>
                  <option value="SimpleCard">Simple card</option>
                  <option value="Note">Note</option>
                </Select>
                <Button variant="outline" size="sm" onClick={addWidget}>
                  <Plus />
                  Add widget
                </Button>
              </div>
            )}
          </div>
        </div>
        <Canvas
          {...args}
          editable={editable}
          widgets={widgets}
          onLayoutChange={(changes) => {
            const byId = new Map(
              changes.map((change) => [change.id, change.layout])
            )
            setWidgets((current) =>
              current.map((widget) => ({
                ...widget,
                layout: byId.get(widget.id) ?? widget.layout,
              }))
            )
            args.onLayoutChange?.(changes)
          }}
          onWidgetPropsChange={(id, props) => {
            setWidgets((current) =>
              current.map((widget) =>
                widget.id === id
                  ? ({ ...widget, props } as CanvasWidget<DemoProps>)
                  : widget
              )
            )
            args.onWidgetPropsChange?.(id, props)
          }}
          onWidgetRemove={(id) => {
            setWidgets((current) => {
              const remaining = current.filter((widget) => widget.id !== id)
              const compacted = layoutChanges(
                remaining,
                createGridLayout(remaining, args.columns)
              )
              return remaining.map((widget, index) => ({
                ...widget,
                layout: compacted[index].layout,
              }))
            })
            args.onWidgetRemove?.(id)
          }}
        />
        {showJson && (
          <section
            className="mt-6 max-h-[40dvh] shrink-0 overflow-auto rounded-xl border border-border bg-muted p-4"
            aria-label="Layout JSON editor"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Layout JSON</h2>
                <p className="mt-1 text-xs text-foreground-muted">
                  Live widget state. Copy it, edit it, or paste a saved layout.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost-muted"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(json)
                      setCopied(true)
                    } catch {
                      setError(
                        "Clipboard unavailable. Select and copy the JSON below."
                      )
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy JSON"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={draft === null || !editable}
                  onClick={applyJson}
                >
                  Apply JSON
                </Button>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={draft === null}
                  onClick={() => {
                    setDraft(null)
                    setError("")
                  }}
                >
                  Discard edits
                </Button>
              </div>
            </div>
            {error && (
              <Notice role="alert" variant="error" className="mb-3">
                {error}
              </Notice>
            )}
            <Textarea
              aria-label="Widgets JSON"
              className="h-80 font-mono text-xs"
              value={draft ?? json}
              readOnly={!editable}
              invalid={!!error}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value)
                setCopied(false)
                setError("")
              }}
            />
            {draft !== null && (
              <p className="mt-2 text-xs text-foreground-muted">
                Unapplied edits. Apply or discard to return to live JSON.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  )
}

const meta = {
  title: "UI/Canvas",
  component: Canvas<DemoProps>,
  decorators: [
    (Story, { globals }) => (
      <div className={globals.theme === "light" ? "light" : "dark"}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: {
      include: ["editable", "columns", "rowHeight", "gap", "stackBelow"],
    },
  },
  args: {
    widgets: initialWidgets,
    components,
    editors,
    getWidgetLabel: (widget) => widget.props.title,
    editable: true,
    columns: 12,
    rowHeight: 60,
    gap: 12,
    stackBelow: 640,
    onLayoutChange: fn(),
    onWidgetPropsChange: fn(),
    onWidgetRemove: fn(),
  },
  render: (args) => (
    <CanvasPlayground key={JSON.stringify(args.widgets)} {...args} />
  ),
} satisfies Meta<typeof Canvas<DemoProps>>

export default meta
type Story = StoryObj<typeof meta>

export const Playground: Story = {}

export const EditingSpace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const scroller = await canvas.findByLabelText("Dashboard widgets")
    await canvas.findByRole("button", { name: "Move Total requests" })
    const spaceBelowWidgets = () => {
      const bottom =
        Math.max(
          ...Array.from(
            canvasElement.querySelectorAll("[data-widget-id]"),
            (item) => item.getBoundingClientRect().bottom
          )
        ) -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      return scroller.scrollHeight - bottom
    }
    await waitFor(() =>
      expect(spaceBelowWidgets()).toBeGreaterThanOrEqual(window.innerHeight - 1)
    )
    scroller.scrollTop = scroller.scrollHeight
    await expect(scroller.scrollTop).toBeGreaterThan(0)
    await userEvent.click(canvas.getByRole("switch", { name: "Read-only" }))
    await waitFor(() =>
      expect(spaceBelowWidgets()).toBeLessThan(window.innerHeight)
    )
    await userEvent.click(canvas.getByRole("switch", { name: "Read-only" }))
    await waitFor(() =>
      expect(spaceBelowWidgets()).toBeGreaterThanOrEqual(window.innerHeight - 1)
    )
  },
}

export const TallWidget: Story = {
  args: {
    widgets: [
      { ...initialWidgets[0], layout: { ...initialWidgets[0].layout, h: 24 } },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const scroller = await canvas.findByLabelText("Dashboard widgets")
    const viewportHeight = scroller.clientHeight
    await expect(viewportHeight).toBeGreaterThan(100)
    await expect(scroller.scrollHeight).toBeGreaterThan(viewportHeight)
    const contentHeight = scroller.scrollHeight
    await userEvent.click(
      canvas.getByRole("button", { name: "Move Total requests" })
    )
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}")
    await waitFor(() =>
      expect(scroller.scrollHeight).toBeGreaterThan(contentHeight)
    )
    await expect(scroller.clientHeight).toBe(viewportHeight)
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Total requests" })
    )
    const panel = canvas.getByRole("complementary", {
      name: "Widget configuration",
    })
    await waitFor(() =>
      expect(Math.abs(panel.clientHeight - viewportHeight)).toBeLessThanOrEqual(
        2
      )
    )
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
  },
}

export const ConfigurationOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Total requests" })
    )
    await expect(
      canvas.getByRole("complementary", { name: "Widget configuration" })
    ).toBeVisible()
  },
}

export const ConfigurationInteractions: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Total requests" })
    )
    const title = canvas.getByRole("textbox", { name: "Title" })
    await userEvent.clear(title)
    await userEvent.type(title, "Requests today")
    await expect(args.onWidgetPropsChange).toHaveBeenLastCalledWith(
      "requests",
      expect.objectContaining({ title: "Requests today" })
    )
    await expect(
      canvas.getByRole("button", { name: "Edit Requests today" })
    ).toBeVisible()

    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Request volume" })
    )
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Period" }),
      "30d"
    )
    await expect(args.onWidgetPropsChange).toHaveBeenLastCalledWith("trend", {
      title: "Request volume",
      period: "30d",
    })
    await userEvent.keyboard("{Escape}")
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Edit Request volume" })
      ).toHaveFocus()
    )

    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Requests today" })
    )
    await expect(canvas.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Requests today"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Requests today" })
    )
    await waitFor(() =>
      expect(body.getByRole("button", { name: "Cancel" })).toHaveFocus()
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(body.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    await expect(canvas.getByRole("complementary")).toBeVisible()
    await expect(args.onWidgetRemove).not.toHaveBeenCalled()

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Requests today" })
    )
    await userEvent.click(body.getByRole("button", { name: "Remove widget" }))
    await waitFor(() =>
      expect(args.onWidgetRemove).toHaveBeenCalledWith("requests")
    )
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
  },
}

export const JsonConfiguration: Story = {
  args: { editors: undefined },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Request volume" })
    )
    const json = canvas.getByRole("textbox", { name: "Widget props (JSON)" })
    await userEvent.clear(json)
    await userEvent.type(json, "invalid")
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Enter a valid JSON object"
    )
    await expect(args.onWidgetPropsChange).not.toHaveBeenCalled()
    await userEvent.clear(json)
    // userEvent treats doubled opening braces as a literal brace.
    await userEvent.type(json, '{{"title":"Edited trend","period":"30d"}')
    await expect(args.onWidgetPropsChange).toHaveBeenLastCalledWith("trend", {
      title: "Edited trend",
      period: "30d",
    })
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const RemovalConfirmation: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Remove Total requests",
      })
    )
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("alertdialog")
    ).toHaveTextContent("Total requests")
  },
}

export const Empty: Story = {
  args: { widgets: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Add a widget to start arranging your canvas."
      )
    ).toBeVisible()
  },
}

export const ReadOnly: Story = {
  args: { editable: false },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Total requests")
    await expect(
      canvas.queryByRole("button", { name: /^(Edit|Remove|Move) / })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Add widget" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("textbox", { name: "Note text" })
    ).toHaveAttribute("readonly")
    await expect(canvas.getByRole("button", { name: "30d" })).toBeDisabled()
    await expect(args.onLayoutChange).not.toHaveBeenCalled()
    await expect(args.onWidgetPropsChange).not.toHaveBeenCalled()
    await expect(args.onWidgetRemove).not.toHaveBeenCalled()
  },
}

export const ReadOnlyToggle: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Total requests" })
    )
    await expect(canvas.getByRole("complementary")).toBeVisible()
    await userEvent.click(canvas.getByRole("switch", { name: "Read-only" }))
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /^(Edit|Remove|Move) / })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByRole("separator")).not.toBeInTheDocument()
    for (const handle of canvasElement.querySelectorAll(
      ".react-resizable-handle"
    )) {
      await expect(handle).not.toBeVisible()
    }
    const note = canvas.getByRole("textbox", { name: "Note text" })
    const previous = (note as HTMLTextAreaElement).value
    await userEvent.type(note, "Cannot edit")
    await expect(note).toHaveValue(previous)
    await expect(args.onWidgetPropsChange).not.toHaveBeenCalled()
    await expect(args.onWidgetRemove).not.toHaveBeenCalled()
    await userEvent.click(canvas.getByRole("switch", { name: "Read-only" }))
    await expect(
      canvas.getByRole("button", { name: "Edit Total requests" })
    ).toBeVisible()
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Total requests" })
    )
    await expect(canvas.getByRole("complementary")).toBeVisible()
  },
}

export const Narrow: Story = {
  render: (args) => (
    <div className="max-w-sm">
      <CanvasPlayground {...args} />
    </div>
  ),
}

export const Interactions: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Move Total requests" })
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Increment value" })[0]
    )
    await expect(args.onWidgetPropsChange).toHaveBeenCalledWith(
      "requests",
      expect.objectContaining({ value: 24681 })
    )
    await userEvent.click(canvas.getByRole("button", { name: "30d" }))
    await expect(args.onWidgetPropsChange).toHaveBeenCalledWith("trend", {
      title: "Request volume",
      period: "30d",
    })
    const handle = canvas.getByRole("button", { name: "Move Total requests" })
    handle.focus()
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}")
    await expect(args.onLayoutChange).toHaveBeenCalled()
    await userEvent.click(canvas.getByRole("button", { name: "Add widget" }))
    await expect(
      canvas.getAllByRole("button", { name: "Move Request volume" })
    ).toHaveLength(2)
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Remove Request volume" })[1]
    )
    const dialog = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(dialog.getByRole("alertdialog")).toBeVisible())
    await expect(args.onWidgetRemove).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus()
    )
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(dialog.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    await expect(
      canvas.getAllByRole("button", { name: "Move Request volume" })
    ).toHaveLength(2)
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Remove Request volume" })[1]
    )
    await userEvent.click(dialog.getByRole("button", { name: "Remove widget" }))
    await waitFor(() => expect(args.onWidgetRemove).toHaveBeenCalledOnce())
    await expect(
      canvas.getAllByRole("button", { name: "Move Request volume" })
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Layout JSON" }))
    const json = canvas.getByRole("textbox", { name: "Widgets JSON" })
    await userEvent.clear(json)
    await userEvent.type(json, "invalid JSON")
    await userEvent.click(canvas.getByRole("button", { name: "Apply JSON" }))
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Enter valid JSON"
    )
    await userEvent.clear(json)
    await userEvent.type(json, "[[]", { skipClick: true })
    await userEvent.click(canvas.getByRole("button", { name: "Apply JSON" }))
    await expect(
      canvas.getByText("Add a widget to start arranging your canvas.")
    ).toBeVisible()
  },
}

const PendingWidget = lazy(
  () => new Promise<{ default: typeof Note }>(() => {})
)
export const LoadingWidget: Story = {
  args: { components: { ...components, Note: PendingWidget } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading widget")
    ).resolves.toBeVisible()
  },
}

function BrokenWidget(): never {
  throw new Error("Intentional story error")
}
export const WidgetError: Story = {
  args: { components: { ...components, Note: BrokenWidget } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("This widget couldn't render.")
    await expect(within(canvasElement).getAllByText("24,680")).toHaveLength(2)
  },
}

export const UnknownWidget: Story = {
  render: () => (
    <div className="p-8">
      <Canvas
        widgets={[
          {
            id: "missing",
            type: "Unregistered",
            props: {},
            layout: { x: 0, y: 0, w: 6, h: 3 },
          },
        ]}
        components={{}}
      />
    </div>
  ),
}
