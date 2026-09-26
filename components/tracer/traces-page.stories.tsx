import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { traceHandlers } from "../../.storybook/scenarios/traces/handlers"
import { TraceDetailPage, TracesPage } from "./traces-page"
import { traceDetail } from "../../.storybook/scenarios/traces/fixtures"

const meta = {
  title: "Tracer/TracesPage",
  component: TracesPage,
  parameters: {
    layout: "fullscreen",
    msw: { handlers: traceHandlers },
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/traces`, query: {} },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Traces">
      <TracesPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof TracesPage>

export default meta
type Story = StoryObj<typeof meta>

const traceListA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production accessibility debt in components/tracer/trace-list.tsx and components/tracer/trace-list-histogram.tsx: dark route timestamps measure 2.49:1 and the visible-count label measures 4.34:1 contrast.",
    },
  },
} as const

export const CollectionRoute: Story = {
  parameters: traceListA11yTodo,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Resolve invoice question")
    ).resolves.toBeVisible()
  },
}

export const DetailRoute: Story = {
  beforeEach: () => {
    const keys = [
      "datool:trace-inspector:detail-tab",
      "datool:trace-inspector:tab",
      "datool:trace-inspector:section:input",
    ]
    const saved = keys.map((key) => localStorage.getItem(key))
    keys.forEach((key) => localStorage.removeItem(key))
    return () => keys.forEach((key, index) => {
      const value = saved[index]
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    })
  },
  parameters: {
    a11y: { test: "todo" },
    docs: {
      description: {
        story:
          "Known production accessibility debt in components/tracer/trace-inspector.tsx: dark inspector metadata and inactive tabs render at 4.35:1 contrast in this route fixture.",
      },
    },
    nextjs: {
      navigation: {
        pathname: `${storybookProject.prefix}/traces/${traceDetail.id}`,
        query: { span: "span-storybook-model" },
      },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Trace details">
      <TraceDetailPage traceId={traceDetail.id} />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Generate invoice response" })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByText("Where is my latest invoice?")
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Views" }))
    await expect(
      canvas.findByRole("combobox", { name: "React view" })
    ).resolves.toBeVisible()
  },
}
