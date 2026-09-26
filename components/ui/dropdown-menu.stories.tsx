import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Button } from "./button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu"

function TraceActions() {
  const [pinned, setPinned] = React.useState(true)
  const [density, setDensity] = React.useState("comfortable")

  return (
    <div className="grid gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Trace actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent aria-label="Trace actions menu">
            <DropdownMenuLabel>Trace actions</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem>Open inspector</DropdownMenuItem>
              <DropdownMenuItem>
                Duplicate query <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={pinned}
              onCheckedChange={setPinned}
            >
              Pin this trace
            </DropdownMenuCheckboxItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Row density</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={density}
                  onValueChange={setDensity}
                >
                  <DropdownMenuRadioItem value="compact">
                    Compact
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="comfortable">
                    Comfortable
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              Delete trace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
      <output className="text-xs text-foreground-muted">
        Pinning {pinned ? "enabled" : "disabled"}; density {density}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/DropdownMenu",
  component: DropdownMenu,
  render: () => <TraceActions />,
} satisfies Meta<typeof DropdownMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Actions: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Trace actions" })
    )
    const menu = within(canvasElement.ownerDocument.body)
    await expect(menu.getByRole("menu")).toBeVisible()
    await userEvent.click(
      menu.getByRole("menuitemcheckbox", { name: "Pin this trace" })
    )
    await expect(
      within(canvasElement).getByText("Pinning disabled; density comfortable")
    ).toBeVisible()
  },
}
