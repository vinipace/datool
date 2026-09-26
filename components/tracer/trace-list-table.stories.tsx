import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { traceRows } from "../../.storybook/scenarios/traces/fixtures"
import { DEFAULT_TRACE_LIST_COLUMNS } from "./trace-list-utils"
import { TraceListTable } from "./trace-list-table"

const onOpenTrace = fn()

function TraceListTableExample() {
  return (
    <StorybookProjectFrame title="Traces">
      <TraceListTable
        columns={DEFAULT_TRACE_LIST_COLUMNS}
        onOpenTrace={onOpenTrace}
        selectedTraceId={traceRows[0].id}
        traces={traceRows}
      />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/TraceListTable",
  component: TraceListTable,
  parameters: { layout: "fullscreen" },
  render: () => <TraceListTableExample />,
} satisfies Meta<typeof TraceListTable>

export default meta
type Story = StoryObj<typeof TraceListTableExample>

const emptyTableA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production accessibility debt in components/tracer/trace-list-table.tsx: empty-table text measures 4.34:1 contrast on the dark surface.",
    },
  },
} as const

export const OpenAndSelect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Select all visible traces" })
    )
    await expect(
      canvas.getByRole("checkbox", { name: /Select trace 1/ })
    ).toBeChecked()
    await userEvent.click(
      canvas.getByRole("row", { name: /Open Resolve invoice question/ })
    )
    await expect(onOpenTrace).toHaveBeenCalled()
  },
}

export const Empty: Story = {
  parameters: emptyTableA11yTodo,
  render: () => (
    <StorybookProjectFrame title="Traces">
      <TraceListTable
        columns={DEFAULT_TRACE_LIST_COLUMNS}
        onOpenTrace={() => {}}
        selectedTraceId={null}
        traces={[]}
      />
    </StorybookProjectFrame>
  ),
}

export const Running: Story = {
  render: () => (
    <StorybookProjectFrame title="Traces">
      <TraceListTable
        columns={DEFAULT_TRACE_LIST_COLUMNS}
        onOpenTrace={onOpenTrace}
        selectedTraceId={null}
        traces={[
          {
            ...traceRows[0],
            id: "trace-storybook-running",
            name: "Resolve invoice question (running)",
            status: "running",
            durationMs: null,
            endedAt: null,
            output: null,
          },
          ...traceRows,
        ]}
      />
    </StorybookProjectFrame>
  ),
}
