import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { traceDetail } from "../../.storybook/scenarios/traces/fixtures"
import { TraceInspector } from "./trace-inspector"
import { ComputedColumnDetails } from "./eval-computed-columns"

function InspectorExample() {
  return (
    <StorybookProjectFrame className="bg-background" title="Trace details">
      <TraceInspector
        initialSpanId="span-storybook-model"
        mode="page"
        onClose={fn()}
        snapshot={traceDetail}
        traceId={traceDetail.id}
      />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/TraceInspector",
  component: TraceInspector,
  parameters: { layout: "fullscreen" },
  render: () => <InspectorExample />,
} satisfies Meta<typeof TraceInspector>

export default meta
type Story = StoryObj<typeof InspectorExample>

function RunningInspectorExample() {
  const [snapshot] = useState(() => {
    const startedAt = Date.now() - 10_000
    const offset = startedAt - Date.parse(traceDetail.startedAt)
    const shift = (time: string) => new Date(Date.parse(time) + offset).toISOString()
    return {
      ...traceDetail,
      status: "running" as const,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: null,
      durationMs: null,
      output: null,
      spans: traceDetail.spans.map(span => ({
        ...span,
        startedAt: shift(span.startedAt),
        endedAt: span.endedAt ? shift(span.endedAt) : null,
        ...(["span-storybook-root", "span-storybook-model"].includes(span.id) ? {
          status: "running" as const,
          endedAt: null,
          durationMs: null,
          output: null,
        } : {}),
      })),
    }
  })
  return (
    <StorybookProjectFrame title="Trace details">
      <TraceInspector
        initialSpanId="span-storybook-model"
        mode="page"
        snapshot={snapshot}
        traceId={snapshot.id}
      />
    </StorybookProjectFrame>
  )
}

export const Running: Story = {
  render: () => <RunningInspectorExample />,
}

const inspectorA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production accessibility debt in components/tracer/trace-inspector.tsx: dark inspector metadata and inactive tabs render at 4.22:1 to 4.35:1 contrast in this fixture.",
    },
  },
} as const

export const NestedTrace: Story = {
  loaders: [
    async () => {
      localStorage.removeItem("datool:trace-inspector:tab")
      return {}
    },
  ],
  parameters: inspectorA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Generate invoice response" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Timeline" }))
    await expect(
      canvas.getByRole("button", { name: "Timeline" })
    ).toHaveAttribute("aria-pressed", "true")
    const handle = canvas.getByRole("separator", { name: "Resize timeline and span details" })
    const originalSize = handle.getAttribute("aria-valuenow")
    handle.focus()
    await userEvent.keyboard(handle.getAttribute("aria-orientation") === "vertical" ? "{ArrowRight}{ArrowRight}" : "{ArrowDown}{ArrowDown}")
    await waitFor(() => expect(handle.getAttribute("aria-valuenow")).not.toBe(originalSize))
    for (const id of ["span-navigator", "span-details"]) {
      const wrapper = canvasElement.querySelector(`#${id}`)!.firstElementChild!
      await expect(getComputedStyle(wrapper).overflow).toBe("hidden")
    }
    const timeline = canvas.getByRole("region", { name: "Scrollable trace spans" })
    await expect(getComputedStyle(timeline).scrollbarWidth).toBe("none")
    await expect(getComputedStyle(timeline).overflow).toBe("scroll")
  },
}

export const EvaluatorScores: Story = {
  loaders: [
    async () => {
      localStorage.setItem("datool:trace-inspector:tab", "evaluators")
      return {}
    },
  ],
  parameters: inspectorA11yTodo,
}

export const PayloadViews: Story = {
  loaders: [async () => {
    localStorage.removeItem("datool:trace-inspector:tab")
    localStorage.removeItem("datool:trace-inspector:detail-tab")
    return {}
  }],
  parameters: inspectorA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const input = await canvas.findByRole("combobox", { name: "Input view type" })
    const output = canvas.getByRole("combobox", { name: "Output view type" })
    await userEvent.click(output)
    await userEvent.click(await page.findByRole("option", { name: "YAML" }))
    await expect(output).toHaveTextContent("YAML")
    await expect(input).toHaveTextContent("LLM")
    await userEvent.click(input)
    await userEvent.click(await page.findByRole("option", { name: "Tree" }))
    await expect(input).toHaveTextContent("Tree")
    await expect(output).toHaveTextContent("YAML")
  },
}

export const GroupMembership: Story = {
  loaders: [async () => {
    localStorage.removeItem("datool:trace-inspector:tab")
    localStorage.removeItem("datool:trace-inspector:detail-tab")
    return {}
  }],
  render: () => (
    <StorybookProjectFrame title="Trace details">
      <TraceInspector
        mode="page"
        snapshot={{
          ...traceDetail,
          spans: traceDetail.spans.map(span => ({
            ...span,
            group: span.id === "span-storybook-root"
              ? { type: "agent", name: "Root span group" }
              : span.id === "span-storybook-model"
                ? { type: "agent", name: "Response generator" }
                : undefined,
          })),
        }}
        traceId={traceDetail.id}
      />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Details" }))
    const rootGroup = within(await canvas.findByRole("region", { name: "Group membership" }))
    await expect(rootGroup.getByRole("link", { name: /Customer support/ })).toBeVisible()
    await expect(rootGroup.queryByText(/Root span group/)).not.toBeInTheDocument()
    await expect(rootGroup.queryByText("Trace group")).not.toBeInTheDocument()

    await userEvent.click(canvas.getByRole("button", { name: /Generate invoice response/ }))
    await expect(canvas.findByRole("link", { name: /Response generator/ })).resolves.toBeVisible()
    await expect(canvas.queryByRole("link", { name: /Customer support/ })).not.toBeInTheDocument()
    await expect(canvas.queryByText("Span group")).not.toBeInTheDocument()

    await userEvent.click(canvas.getByRole("button", { name: /billing_lookup/ }))
    await expect(canvas.findByRole("heading", { name: "billing_lookup" })).resolves.toBeVisible()
    await expect(canvas.queryByRole("region", { name: "Group membership" })).not.toBeInTheDocument()
  },
}

function SectionPersistenceExample() {
  const [visible, setVisible] = useState(true)
  const [index, setIndex] = useState(1)
  const traceId = `trace-section-preferences-${index}`
  return (
    <StorybookProjectFrame title="Trace section preferences">
      {visible ? (
        <TraceInspector
          mode="page"
          initialSpanId="span-storybook-root"
          onClose={() => setVisible(false)}
          snapshot={{
            ...traceDetail,
            id: traceId,
            name: `Trace ${index}`,
            attributes: { ...traceDetail.attributes, "error.message": "Example captured error" },
            spans: traceDetail.spans.map(span => ({
              ...span,
              traceId,
              ...(span.parentId === null ? {
                name: `Trace ${index}`,
                attributes: { ...span.attributes, "error.message": "Example captured error" },
              } : {}),
            })),
          }}
          traceId={traceId}
          customColumnDetails={
            <ComputedColumnDetails
              columns={[{ id: "section-preference-example", name: "Saved custom field", mode: "expression", code: "1" }]}
              cells={{ "section-preference-example": { [traceId]: { value: "Saved field value" } } }}
              rowId={traceId}
              onRemove={fn()}
            />
          }
        />
      ) : (
        <Button onClick={() => { setIndex(value => value + 1); setVisible(true) }}>
          Open another trace
        </Button>
      )}
    </StorybookProjectFrame>
  )
}

export const SectionPreferences: Story = {
  parameters: inspectorA11yTodo,
  render: () => <SectionPersistenceExample />,
  beforeEach: () => {
    const keys = [
      "datool:trace-inspector:tab",
      "datool:trace-inspector:detail-tab",
      ...["input", "output", "error", "scores", "custom-field:section-preference-example"].map(
        section => `datool:trace-inspector:section:${section}`
      ),
    ]
    const saved = keys.map(key => localStorage.getItem(key))
    keys.forEach(key => localStorage.removeItem(key))
    return () => keys.forEach((key, index) => {
      const value = saved[index]
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Trace 1" })
    const sections = [
      ["Input", "input"],
      ["Output", "output"],
      ["Error", "error"],
      ["Trace scores", "scores"],
      ["Saved custom field", "custom-field:section-preference-example"],
    ] as const
    const section = (label: string) => canvas.getByText(label, { selector: "summary span", exact: true }).closest("details")!
    for (const [label, key] of sections) {
      await expect(section(label)).toHaveAttribute("open")
      await userEvent.click(section(label).querySelector("summary")!)
      await waitFor(() => expect(localStorage.getItem(`datool:trace-inspector:section:${key}`)).toBe("closed"))
    }

    await userEvent.click(canvas.getByRole("button", { name: /Generate invoice response/ }))
    await canvas.findByRole("heading", { name: "Generate invoice response" })
    for (const label of ["Input", "Output", "Trace scores", "Saved custom field"])
      await expect(section(label)).not.toHaveAttribute("open")

    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await userEvent.click(canvas.getByRole("button", { name: "Open another trace" }))
    await canvas.findByRole("heading", { name: "Trace 2" })
    for (const [label] of sections)
      await expect(section(label)).not.toHaveAttribute("open")

    const outputSummary = section("Output").querySelector("summary")!
    await userEvent.click(outputSummary)
    await waitFor(() => expect(localStorage.getItem("datool:trace-inspector:section:output")).toBe("open"))
    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await userEvent.click(canvas.getByRole("button", { name: "Open another trace" }))
    await canvas.findByRole("heading", { name: "Trace 3" })
    for (const [label] of sections) {
      if (label === "Output") await expect(section(label)).toHaveAttribute("open")
      else await expect(section(label)).not.toHaveAttribute("open")
    }
  },
}

function LayoutPersistenceExample() {
  const [narrow, setNarrow] = useState(false)
  return (
    <div className="space-y-2">
      <Button onClick={() => setNarrow(value => !value)}>
        {narrow ? "Use wide layout" : "Use narrow layout"}
      </Button>
      <div style={{ width: narrow ? 390 : 900, maxWidth: "100%" }}>
        <SectionPersistenceExample />
      </div>
    </div>
  )
}

export const LayoutPreferences: Story = {
  parameters: inspectorA11yTodo,
  render: () => <LayoutPersistenceExample />,
  beforeEach: () => {
    const keys = [
      "datool:trace-inspector:tab",
      ...["horizontal", "vertical"].map(orientation =>
        `react-resizable-panels:trace-inspector-${orientation}:span-navigator:span-details`
      ),
    ]
    const saved = keys.map(key => localStorage.getItem(key))
    keys.forEach(key => localStorage.removeItem(key))
    return () => keys.forEach((key, index) => {
      const value = saved[index]
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const handle = () => canvas.getByRole("separator", { name: "Resize span navigator and details" })
    const size = () => Number(handle().getAttribute("aria-valuenow"))
    await canvas.findByRole("heading", { name: "Trace 1" })
    await waitFor(() => expect(handle()).toHaveAttribute("aria-orientation", "vertical"))
    const original = size()
    handle().focus()
    await userEvent.keyboard("{ArrowRight}{ArrowRight}")
    await waitFor(() => expect(size()).not.toBe(original))
    const wideSize = size()
    const wideKey = "react-resizable-panels:trace-inspector-horizontal:span-navigator:span-details"
    await waitFor(() => expect(JSON.parse(localStorage.getItem(wideKey) ?? "{}")["span-navigator"]).toBeCloseTo(wideSize, 0))

    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await userEvent.click(canvas.getByRole("button", { name: "Open another trace" }))
    await canvas.findByRole("heading", { name: "Trace 2" })
    await waitFor(() => expect(size()).toBeCloseTo(wideSize, 0))

    await userEvent.click(canvas.getByRole("button", { name: "Use narrow layout" }))
    const trigger = await canvas.findByRole("button", { name: "Browse traces" })
    await expect(canvas.queryByRole("separator")).not.toBeInTheDocument()
    await userEvent.click(trigger)
    const drawer = within(await page.findByRole("dialog", { name: "Trace navigator" }))
    await expect(drawer.getByRole("region", { name: "Trace span hierarchy" })).toBeVisible()
    await userEvent.click(drawer.getByRole("button", { name: /^llm Generate invoice response/ }))
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(canvas.findByRole("heading", { name: "Generate invoice response" })).resolves.toBeVisible()
    await expect(trigger).toHaveFocus()
    await userEvent.click(canvas.getByRole("button", { name: "Use wide layout" }))
    await waitFor(() => expect(handle()).toHaveAttribute("aria-orientation", "vertical"))
    await waitFor(() => expect(size()).toBeCloseTo(wideSize, 0))
    await userEvent.click(canvas.getByRole("button", { name: "Use narrow layout" }))
    await expect(canvas.findByRole("button", { name: "Browse traces" })).resolves.toBeVisible()
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await userEvent.click(canvas.getByRole("button", { name: "Open another trace" }))
    await canvas.findByRole("heading", { name: "Trace 3" })
    await expect(canvas.getByRole("button", { name: "Browse traces" })).toBeVisible()
    await expect(canvas.queryByRole("separator")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Timeline" }))
    await userEvent.click(await canvas.findByRole("button", { name: "Browse timeline" }))
    const timeline = within(await page.findByRole("dialog", { name: "Timeline" }))
    await expect(timeline.getByRole("region", { name: "Scrollable trace spans" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(canvas.getByRole("button", { name: "Browse timeline" })).toHaveFocus()
  },
}
