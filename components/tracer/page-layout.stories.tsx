import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CollectionHeaderControls, HeaderSlot } from "./collection-header"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { PageLayout } from "./page-layout"

function PageExample({ breadcrumb = false }: { breadcrumb?: boolean }) {
  const search = useCollectionFilter("scorers")
  const [refreshes, setRefreshes] = React.useState(0)
  return (
    <PageLayout
      className="h-[min(720px,100dvh)]"
      title={breadcrumb ? "Invoice quality" : "Scorers"}
      breadcrumbs={
        breadcrumb ? [{ label: "Scorers", href: "/p/demo/scorers" }] : undefined
      }
    >
      <CollectionHeaderControls
        onRefresh={() => setRefreshes((value) => value + 1)}
        actions={
          <Button size="sm">
            <Plus />
            New scorer
          </Button>
        }
      >
        <CollectionFilterBar resource="scorers" {...search} />
      </CollectionHeaderControls>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <p className="text-sm text-foreground-muted">
          The page content owns its data and scrolling.
        </p>
        <output className="sr-only" aria-label="Page state">
          {search.value}; refreshes: {refreshes}
        </output>
      </div>
    </PageLayout>
  )
}

function DynamicTitleExample() {
  const [loaded, setLoaded] = React.useState(false)
  return (
    <PageLayout
      title="Dashboard"
      breadcrumbs={[{ label: "Dashboards", href: "/p/demo/dashboards" }]}
    >
      {loaded && (
        <HeaderSlot name="title">
          <h1 className="truncate text-sm font-medium">Revenue overview</h1>
        </HeaderSlot>
      )}
      <Button onClick={() => setLoaded((current) => !current)}>
        Toggle loaded page
      </Button>
    </PageLayout>
  )
}

const meta = {
  title: "Tracer/PageLayout",
  component: PageLayout,
  parameters: { layout: "fullscreen" },
  render: () => <PageExample />,
} satisfies Meta<typeof PageLayout>
export default meta
type Story = StoryObj<typeof meta>

export const Collection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(
      header.getByRole("heading", { name: "Scorers", level: 1 })
    ).toBeVisible()
    await expect(
      header.getByRole("button", { name: "New scorer" })
    ).toBeVisible()
    await userEvent.click(
      header.getByRole("combobox", { name: "Filter expression" })
    )
    await userEvent.paste('name : "quality"')
    await userEvent.keyboard("{Enter}")
    await userEvent.click(header.getByRole("button", { name: "Refresh" }))
    await expect(canvas.getByLabelText("Page state")).toHaveTextContent(
      'name : "quality"; refreshes: 1'
    )
  },
}

export const DynamicTitle: Story = {
  render: () => <DynamicTitleExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Dashboard"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle loaded page" })
    )
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Revenue overview"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle loaded page" })
    )
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Dashboard"
    )
  },
}

export const WithBreadcrumb: Story = {
  render: () => <PageExample breadcrumb />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const breadcrumb = within(
      canvas.getByRole("navigation", { name: "Breadcrumb" })
    )
    await expect(
      breadcrumb.getByRole("link", { name: "Scorers" })
    ).toHaveAttribute("href", "/p/demo/scorers")
    await expect(
      canvas.getByRole("heading", { name: "Invoice quality", level: 1 })
    ).toBeVisible()
  },
}

export const Narrow: Story = {
  render: () => (
    <div className="w-[375px] max-w-full">
      <PageExample />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const header = within(canvasElement).getByRole("banner", {
      name: "Page controls",
    })
    await expect(
      within(header).getByRole("button", { name: "New scorer" })
    ).toBeVisible()
    await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
    await expect(
      within(header)
        .getByRole("combobox", { name: "Filter expression" })
        .getBoundingClientRect().width
    ).toBeGreaterThan(120)
  },
}
