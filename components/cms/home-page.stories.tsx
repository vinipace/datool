import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import type { Faq } from "@/payload-types"
import {
  faqContent,
  homeFaqSlugs,
  landingBlocks,
  richText,
} from "@/cms/seed-content"
import { agentPages } from "./agent-pages"
import { HomePage } from "./home-page"
import { MarketingShell } from "./marketing-shell"

const faqs: Faq[] = faqContent
  .filter((item) => homeFaqSlugs.includes(item.slug))
  .map((item, index) => ({
    ...item,
    id: index + 1,
    answer: richText(item.answer),
    _status: "published",
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
  }))
const blocks = landingBlocks(faqs.map((faq) => faq.id)).map((block) =>
  block.blockType === "faq" ? { ...block, items: faqs } : block
)

const meta = {
  title: "CMS/Home",
  component: HomePage,
  args: { blocks },
  parameters: {
    layout: "fullscreen",
    // The marketing home ships in light mode only.
    themes: { themeOverride: "light" },
    msw: {
      handlers: [
        http.get("https://api.github.com/repos/vinipace/datool", () =>
          HttpResponse.json({ stargazers_count: 1240 })
        ),
      ],
    },
  },
  render: (args) => (
    <MarketingShell>
      <HomePage {...args} />
    </MarketingShell>
  ),
} satisfies Meta<typeof HomePage>

export default meta
type Story = StoryObj<typeof meta>

export const Home: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("heading", { level: 1, name: /Build AI agents\./ })
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: /Observe the agents you already run/ })
    ).toHaveAttribute("href", "/docs/get-started/first-trace")
    await expect(
      canvas.getByRole("link", { name: /Improve every one of them/ })
    ).toHaveAttribute("href", "/product/observe")
    const agents = within(canvasElement.querySelector("#agents")!)
    for (const page of agentPages)
      await expect(
        agents.getByRole("link", { name: new RegExp(page.name) })
      ).toHaveAttribute("href", page.href)
    for (const link of canvas.getAllByRole("link", {
      name: /Request a demo/,
    }))
      await expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("https://wa.me/551151995330?text=")
      )
    await expect(canvas.getByText(faqs[0].question)).toBeVisible()
    // Every question links to its own page; modified clicks open it.
    const answerLinks =
      canvasElement.querySelectorAll<HTMLAnchorElement>('a[href^="/faq/"]')
    await expect(
      [...answerLinks].map((link) => link.getAttribute("href"))
    ).toEqual(faqs.map((faq) => `/faq/${faq.slug}`))
    await expect(
      await canvas.findByLabelText("Example helpful answers chart")
    ).toBeVisible()
    // The slider walks the screen through Build, Observe and Improve.
    const tour = within(
      canvas.getByRole("group", { name: "Explore the workspace" })
    )
    const improve = tour.getByRole("button", { name: /Improve/ })
    await userEvent.click(improve)
    await expect(improve).toHaveAttribute("aria-pressed", "true")
    await expect(
      await canvas.findByRole("region", { name: "Example eval run" })
    ).toBeVisible()
    await expect(
      canvas.getByText("Stride Support · v2 instructions")
    ).toBeVisible()
    // The product screen also switches between the app's two areas.
    const [build] = canvas.getAllByRole("tab", { name: "Build" })
    await userEvent.click(build)
    await expect(build).toHaveAttribute("aria-selected", "true")
    await expect(
      await canvas.findByRole("row", {
        name: /Open example: Running shoes for a half marathon/,
      })
    ).toBeVisible()
    await userEvent.click(canvas.getAllByRole("tab", { name: "Observe" })[0])
    await expect(
      await canvas.findByLabelText("Example trace inspector")
    ).toBeInTheDocument()
  },
}

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
}
