import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fireEvent, userEvent, within } from "storybook/test"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu"

function TraceContextMenu() {
  const [showAttributes, setShowAttributes] = React.useState(true)
  const [format, setFormat] = React.useState("pretty")

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className="w-80 rounded-lg border border-dashed border-border bg-muted p-8 text-left text-sm text-foreground"
        >
          Right-click this trace row
        </button>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent aria-label="Trace row actions">
          <ContextMenuLabel>Invoice extraction</ContextMenuLabel>
          <ContextMenuGroup>
            <ContextMenuItem>Open inspector</ContextMenuItem>
            <ContextMenuItem>
              Copy trace ID <ContextMenuShortcut>⌘C</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={showAttributes}
            onCheckedChange={setShowAttributes}
          >
            Show attributes
          </ContextMenuCheckboxItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Output format</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={format} onValueChange={setFormat}>
                <ContextMenuRadioItem value="pretty">
                  Pretty
                </ContextMenuRadioItem>
                <ContextMenuRadioItem value="json">JSON</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Delete trace</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  )
}

const meta = {
  title: "UI/ContextMenu",
  component: ContextMenu,
  render: () => <TraceContextMenu />,
} satisfies Meta<typeof ContextMenu>

export default meta
type Story = StoryObj<typeof meta>

export const RowActions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    fireEvent.contextMenu(
      canvas.getByRole("button", { name: "Right-click this trace row" })
    )
    const menu = within(canvasElement.ownerDocument.body)
    const item = await menu.findByRole("menuitemcheckbox", {
      name: "Show attributes",
    })
    await expect(menu.getByRole("menu")).toBeVisible()
    await userEvent.click(item)
  },
}
