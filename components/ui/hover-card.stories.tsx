import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card"

const preview = {
  duration: "842 ms",
  name: "Invoice extraction",
  status: "Completed",
}

const meta = {
  title: "UI/HoverCard",
  component: HoverCard,
  render: () => (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        payload={preview}
        render={
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm underline"
          />
        }
      >
        Preview trace
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="font-medium">{preview.name}</p>
        <p className="mt-1 text-foreground-muted">
          {preview.status} in {preview.duration}
        </p>
      </HoverCardContent>
    </HoverCard>
  ),
} satisfies Meta<typeof HoverCard>

export default meta
type Story = StoryObj<typeof meta>

export const Preview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", { name: "Preview trace" })
    )
    await expect(
      within(canvasElement.ownerDocument.body).getByText("Invoice extraction")
    ).toBeVisible()
  },
}
