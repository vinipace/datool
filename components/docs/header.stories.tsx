import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/page"
import { DocsHeader } from "./header"
import { DocsProvider } from "./provider"

function VisibleHeader() {
  return <DocsHeader className="md:flex" />
}

const meta = {
  title: "Docs/Header",
  component: DocsHeader,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [http.get("/api/docs/search", () => HttpResponse.json([]))],
    },
  },
  render: () => (
    <DocsProvider>
      <DocsLayout
        tree={{ name: "Documentation", children: [] }}
        nav={{ title: "Datool Docs", url: "/docs" }}
        slots={{ header: VisibleHeader }}
        themeSwitch={{ enabled: false }}
        containerProps={{ className: "datool-docs" }}
      >
        <DocsPage>
          <DocsTitle>Documentation</DocsTitle>
          <DocsBody>Learn how to trace and evaluate your application.</DocsBody>
        </DocsPage>
      </DocsLayout>
    </DocsProvider>
  ),
} satisfies Meta<typeof DocsHeader>
export default meta
type Story = StoryObj<typeof meta>

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const header = within(within(canvasElement).getByRole("banner"))
    await expect(
      header.getByRole("link", { name: "Datool Docs" })
    ).toBeVisible()
    await userEvent.click(header.getByRole("button", { name: "Open Search" }))
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(
      dialog.getByRole("textbox", { name: "Search documentation" })
    ).toBeVisible()
    await expect(
      dialog.getByRole("button", { name: "Send your first trace" })
    ).toBeVisible()
    await userEvent.click(dialog.getByRole("button", { name: "Close Search" }))
  },
}
