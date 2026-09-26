import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"

function ConfirmationDialog({
  defaultOpen = false,
}: {
  defaultOpen?: boolean
}) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger asChild>
        <Button>Archive run</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this evaluation run?</DialogTitle>
          <DialogDescription>
            Archived runs remain available to project administrators.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="destructive">Archive run</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const meta = {
  title: "UI/Dialog",
  component: Dialog,
  render: () => <ConfirmationDialog />,
} satisfies Meta<typeof Dialog>

export default meta
type Story = StoryObj<typeof meta>

export const OpenAndClose: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Archive run" }))
    const documentBody = within(canvasElement.ownerDocument.body)
    await expect(
      documentBody.getByRole("dialog", {
        name: "Archive this evaluation run?",
      })
    ).toBeVisible()
    await userEvent.click(documentBody.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        documentBody.queryByRole("dialog", {
          name: "Archive this evaluation run?",
        })
      ).not.toBeInTheDocument()
    )
  },
}

export const InitiallyOpen: Story = {
  render: () => <ConfirmationDialog defaultOpen />,
}
