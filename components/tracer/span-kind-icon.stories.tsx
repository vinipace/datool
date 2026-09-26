import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { SessionKindIcon, SpanKindIcon } from "./span-kind-icon"

const traceKinds = [
  "agent",
  "chat",
  "code",
  "custom",
  "eval",
  "function",
  "llm",
  "score",
  "task",
  "tool",
  "workflow",
] as const

function KindsExample() {
  return (
    <div className="flex flex-wrap gap-3">
      {traceKinds.map((kind) => (
        <SpanKindIcon key={kind} kind={kind} />
      ))}
      <SessionKindIcon />
    </div>
  )
}

const meta = {
  title: "Tracer/SpanKindIcon",
  component: SpanKindIcon,
  render: () => <KindsExample />,
} satisfies Meta<typeof SpanKindIcon>

export default meta
type Story = StoryObj<typeof KindsExample>

export const SemanticKinds: Story = {}
