import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Button } from "./button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

const meta = {
  title: "UI/Tooltip",
  component: Tooltip,
  render: () => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Refresh traces</Button>
        </TooltipTrigger>
        <TooltipContent>Fetch the latest recorded traces.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", { name: "Refresh traces" })
    )
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("tooltip")
    ).toHaveTextContent("Fetch the latest recorded traces.")
  },
}
