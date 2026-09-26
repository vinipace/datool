import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Braces } from "lucide-react"
import { expect, userEvent, within } from "storybook/test"
import { InspectorSection } from "./inspector-section"

function InspectorSectionHarness() {
  return (
    <div className="w-96">
      <InspectorSection
        icon={<Braces className="size-4" />}
        label="Trace attributes"
      >
        <dl className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">workflow</dt>
            <dd>invoice-extraction</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">environment</dt>
            <dd>production</dd>
          </div>
        </dl>
      </InspectorSection>
    </div>
  )
}

const meta = {
  title: "UI/InspectorSection",
  component: InspectorSection,
  render: () => <InspectorSectionHarness />,
} satisfies Meta<typeof InspectorSection>

export default meta
type Story = StoryObj<typeof InspectorSectionHarness>

export const Disclosure: Story = {
  play: async ({ canvasElement }) => {
    const summary = within(canvasElement).getByText("Trace attributes")
    const section = summary.closest("details")
    await expect(section).toHaveAttribute("open")
    await userEvent.click(summary)
    await expect(section).not.toHaveAttribute("open")
  },
}
