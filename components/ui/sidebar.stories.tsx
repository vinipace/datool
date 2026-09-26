import * as React from "react"
import Link from "next/link"
import { Database, MoreHorizontal, Settings, Workflow } from "lucide-react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./sidebar"

function SidebarState() {
  const { state } = useSidebar()
  return (
    <output className="text-xs text-foreground-muted">Sidebar {state}</output>
  )
}

function WorkspaceShell({ defaultOpen = true }: { defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen)

  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <span className="px-2 text-sm font-semibold">Datool</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Explore</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive
                  render={<Link href="/p/invoices/traces" />}
                >
                  <Workflow />
                  <span>Traces</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>18</SidebarMenuBadge>
                <SidebarMenuAction aria-label="More trace actions">
                  <MoreHorizontal className="size-4" />
                </SidebarMenuAction>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/p/invoices/datasets" />}
                >
                  <Database />
                  <span>Datasets</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link href="/settings/mcp" />}>
                <Settings />
                <span>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail aria-label="Toggle sidebar rail" />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-3 border-b border-border px-4">
          <SidebarTrigger />
          <span className="text-sm font-medium">Invoice extraction</span>
        </header>
        <section
          aria-label="Trace workspace"
          className="grid flex-1 content-center gap-2 p-6"
        >
          <h1 className="text-lg font-semibold">Trace workspace</h1>
          <SidebarState />
        </section>
      </SidebarInset>
    </SidebarProvider>
  )
}

const meta = {
  title: "UI/Sidebar",
  component: SidebarProvider,
  parameters: { layout: "fullscreen" },
  render: () => <WorkspaceShell />,
} satisfies Meta<typeof SidebarProvider>

export default meta
type Story = StoryObj<typeof meta>

export const Toggle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Sidebar expanded")).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle sidebar" })
    )
    await expect(canvas.getByText("Sidebar collapsed")).toBeVisible()
  },
}

export const Collapsed: Story = {
  render: () => <WorkspaceShell defaultOpen={false} />,
}

export const PersistedUncontrolled: Story = {
  beforeEach: () => {
    const previous = localStorage.getItem("datool_sidebar_open")
    localStorage.setItem("datool_sidebar_open", "true")
    return () => {
      if (previous === null) localStorage.removeItem("datool_sidebar_open")
      else localStorage.setItem("datool_sidebar_open", previous)
    }
  },
  render: () => (
    <SidebarProvider defaultOpen={false}>
      <SidebarTrigger />
      <SidebarState />
    </SidebarProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Sidebar expanded")).toBeVisible()
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle sidebar" })
    )
    await expect(canvas.getByText("Sidebar collapsed")).toBeVisible()
    await expect(localStorage.getItem("datool_sidebar_open")).toBe("false")
  },
}
