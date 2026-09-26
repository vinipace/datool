import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { ResourceSwitcher } from "./resource-switcher"

const projects = [
  { id: "billing", name: "Billing API", href: "/p/billing/traces" },
  {
    id: "invoices",
    name: "Invoice extraction",
    href: "/p/invoices/traces",
  },
  {
    id: "support",
    name: "Support copilot",
    href: "/p/support/traces",
  },
]

function ProjectSwitcher({
  error = null,
  initialOpen = false,
  loading = false,
  showItems = true,
}: {
  error?: Error | null
  initialOpen?: boolean
  loading?: boolean
  showItems?: boolean
}) {
  const [open, setOpen] = React.useState(initialOpen)
  const [search, setSearch] = React.useState("")
  const [created, setCreated] = React.useState(false)
  const visibleProjects = showItems
    ? projects.filter((project) =>
        project.name.toLowerCase().includes(search.toLowerCase())
      )
    : []

  return (
    <div className="grid gap-3">
      <ResourceSwitcher
        error={error}
        items={visibleProjects}
        label="project"
        loading={loading}
        moreHref="/projects"
        open={open}
        search={search}
        selectedId="invoices"
        value="Invoice extraction"
        onCreate={() => setCreated(true)}
        onOpenChange={setOpen}
        onRetry={() => setOpen(true)}
        onSearchChange={setSearch}
      />
      {created ? (
        <output className="text-sm text-foreground-muted">
          Create project requested
        </output>
      ) : null}
    </div>
  )
}

const meta = {
  title: "UI/ResourceSwitcher",
  component: ResourceSwitcher,
  render: () => <ProjectSwitcher />,
} satisfies Meta<typeof ResourceSwitcher>

export default meta
type Story = StoryObj<typeof ProjectSwitcher>

export const SearchAndCreate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Switch project: Invoice extraction",
      })
    )
    const documentBody = within(canvasElement.ownerDocument.body)
    const search = documentBody.getByRole("textbox", { name: "Find project" })
    await userEvent.type(search, "billing")
    await expect(
      documentBody.getByRole("link", { name: "Billing API" })
    ).toBeVisible()
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create project" })
    )
    await expect(canvas.getByText("Create project requested")).toBeVisible()
  },
}

export const Loading: Story = {
  render: () => <ProjectSwitcher initialOpen loading />,
}

export const Empty: Story = {
  render: () => <ProjectSwitcher initialOpen showItems={false} />,
}

export const Error: Story = {
  render: () => (
    <ProjectSwitcher
      error={new globalThis.Error("Could not load projects.")}
      initialOpen
    />
  ),
}
