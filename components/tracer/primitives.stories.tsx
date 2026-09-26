import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import {
  EmptyState,
  ErrorState,
  JsonPreview,
  LoadingState,
  StatusPill,
  ValuePreview,
} from "./primitives"

const meta = {
  title: "Tracer/Primitives",
  component: EmptyState,
  args: {
    title: "No traces yet",
    detail: "Run a workflow or send an SDK trace to populate this collection.",
  },
  render: () => (
    <div className="grid max-w-3xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Trace components</CardTitle>
          <CardDescription>
            Reusable states and value treatments for trace collections.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <StatusPill status="completed" />
          <StatusPill status="running" />
          <StatusPill status="errored" />
          <ValuePreview value={{ invoice: "ready", total: 89.5 }} />
        </div>
        <JsonPreview
          className="m-4"
          value={{ status: "ready", items: ["invoice", "receipt"] }}
        />
      </Card>
      <Card>
        <LoadingState label="Loading trace data" />
      </Card>
      <Card>
        <EmptyState
          detail="Run a workflow or send an SDK trace to populate this collection."
          title="No traces yet"
        />
      </Card>
      <Card>
        <ErrorState
          error={new Error("The trace service did not respond.")}
          onRetry={() => {}}
        />
      </Card>
    </div>
  ),
} satisfies Meta<typeof EmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {}
