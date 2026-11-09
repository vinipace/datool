import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { agentConfigurationSchema } from "@/src/lib/build/contracts"
import { AgentGuardrails } from "./agent-guardrails"

const meta = {
  title: "Build/AgentGuardrails",
  component: AgentGuardrails,
  args: {
    configuration: agentConfigurationSchema.parse({
      channelAllowlist: ["web", "whatsapp", "telegram", "api"],
    }),
    onChange: () => {},
  },
  render: function Render(args) {
    const [configuration, setConfiguration] = React.useState(args.configuration)
    return (
      <AgentGuardrails
        configuration={configuration}
        onChange={setConfiguration}
      />
    )
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AgentGuardrails>
export default meta
type Story = StoryObj<typeof meta>
export const JevEnabled: Story = {}
export const JevDisabled: Story = {
  args: {
    configuration: agentConfigurationSchema.parse({
      guardrails: { jevCheckEnabled: false },
      channelAllowlist: ["web", "telegram"],
    }),
  },
}
export const ChannelException: Story = {
  args: {
    configuration: agentConfigurationSchema.parse({
      channelAllowlist: ["web", "telegram"],
      channelOverrides: {
        telegram: { jevCheckEnabled: false, model: "test-model" },
      },
    }),
  },
}
