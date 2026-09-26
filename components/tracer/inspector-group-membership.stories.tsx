import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { InspectorGroupMembership } from "./inspector-group-membership"

function GroupMembershipExample() {
  return (
    <StorybookProjectFrame title="Trace inspector">
      <div className="max-w-lg p-4">
        <h2 className="sr-only">Trace group details</h2>
        <InspectorGroupMembership
          isRootSelected={false}
          spanGroup={{ name: "Billing lookup", type: "agent", version: "v2" }}
          traceGroup={{
            name: "Customer support",
            type: "workflow",
            version: "2026.09",
          }}
          workspaceHref={(path) => `${storybookProject.prefix}${path}`}
        />
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/InspectorGroupMembership",
  component: InspectorGroupMembership,
  parameters: { layout: "fullscreen" },
  render: () => <GroupMembershipExample />,
} satisfies Meta<typeof InspectorGroupMembership>

export default meta
type Story = StoryObj<typeof GroupMembershipExample>

export const Grouped: Story = {}
export const Unassigned: Story = {
  render: () => (
    <InspectorGroupMembership isRootSelected workspaceHref={(path) => path} />
  ),
}
