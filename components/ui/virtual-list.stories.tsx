import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Button } from "./button"
import { VirtualList } from "./virtual-list"

type TraceRow = { id: string; name: string; duration: string }

function createTraceRows(): TraceRow[] {
  return Array.from({ length: 80 }, (_, index) => ({
    id: `trace-${index + 1}`,
    name: `Workflow ${index + 1}`,
    duration: `${120 + index * 7} ms`,
  }))
}

function TraceList({ empty = false }: { empty?: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const items = React.useMemo(() => (empty ? [] : createTraceRows()), [empty])
  return (
    <div className="h-72 w-[34rem] max-w-full rounded-md border border-border">
      <VirtualList
        empty={
          <p className="p-4 text-sm text-foreground-muted">
            No traces captured yet.
          </p>
        }
        footer={
          <div className="border-t border-border p-2">
            <Button size="sm" variant="ghost-muted">
              Load more
            </Button>
          </div>
        }
        itemKey={(item) => item.id}
        items={items}
        label="Captured traces"
        scrollRef={scrollRef}
      >
        {(item) => (
          <article className="flex min-h-11 items-center justify-between border-b border-border px-3 text-sm">
            <span>{item.name}</span>
            <span className="text-foreground-muted">{item.duration}</span>
          </article>
        )}
      </VirtualList>
    </div>
  )
}

const meta = {
  title: "UI/VirtualList",
  component: VirtualList,
  render: () => <TraceList />,
} satisfies Meta<typeof VirtualList>

export default meta
type Story = StoryObj<typeof TraceList>

export const VirtualizedRows: Story = {
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("region", {
      name: "Captured traces",
    })
    await userEvent.click(region)
    await expect(region).toHaveFocus()
    await expect(within(region).getByText("Workflow 1")).toBeVisible()
  },
}

export const Empty: Story = {
  render: () => <TraceList empty />,
}
