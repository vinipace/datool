import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { JsonCode } from "./json-code"

const meta = {
  title: "Tracer/JsonCode",
  component: JsonCode,
  args: { text: '{\n  "invoice": { "status": "ready" },\n  "amount": 89.5\n}' },
} satisfies Meta<typeof JsonCode>

export default meta
type Story = StoryObj<typeof meta>

export const SyntaxHighlighted: Story = {}
