import { useRef, useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog"

function WidgetRemovalDialog({
  initialOpen = false,
}: {
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [outcome, setOutcome] = useState("No choice yet")
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="grid gap-3">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button variant="outline" />}>
          Remove widget
        </AlertDialogTrigger>
        <AlertDialogContent size="sm" initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove widget?</AlertDialogTitle>
            <AlertDialogDescription>
              “Request volume” will be removed from this canvas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              ref={cancelRef}
              onClick={() => setOutcome("Removal cancelled")}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setOutcome("Widget removed")
                setOpen(false)
              }}
            >
              Remove widget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <output aria-live="polite" className="text-sm text-foreground-muted">
        {outcome}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/AlertDialog",
  component: AlertDialog,
  render: () => <WidgetRemovalDialog />,
} satisfies Meta<typeof AlertDialog>

export default meta
type Story = StoryObj<typeof WidgetRemovalDialog>

async function getRemovalDialog(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole(
    "alertdialog",
    {
      name: "Remove widget?",
    }
  )
  await waitFor(() => expect(dialog).toBeVisible())
  return dialog
}

async function expectRemovalDialogClosed(canvasElement: HTMLElement) {
  await waitFor(() =>
    expect(
      within(canvasElement.ownerDocument.body).queryByRole("alertdialog")
    ).not.toBeInTheDocument()
  )
}

export const Default: Story = {}

export const OpenWithInitialFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Remove widget" }))
    const dialog = await getRemovalDialog(canvasElement)
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel).toHaveFocus())
  },
}

export const ConfirmRemoval: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Remove widget" }))
    const dialog = await getRemovalDialog(canvasElement)
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove widget" })
    )
    await expectRemovalDialogClosed(canvasElement)
    await expect(canvas.getByText("Widget removed")).toBeVisible()
  },
}

export const CancelRemoval: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Remove widget" }))
    const dialog = await getRemovalDialog(canvasElement)
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" })
    )
    await expectRemovalDialogClosed(canvasElement)
    await expect(canvas.getByText("Removal cancelled")).toBeVisible()
  },
}

export const KeyboardCancel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Remove widget" }))
    const dialog = await getRemovalDialog(canvasElement)
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel).toHaveFocus())
    await userEvent.keyboard("{Enter}")
    await expectRemovalDialogClosed(canvasElement)
    await expect(canvas.getByText("Removal cancelled")).toBeVisible()
  },
}
