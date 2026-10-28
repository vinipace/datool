import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, waitFor, within } from "storybook/test"
import { agentLandingContent } from "@/cms/agent-landing-content"
import { AgentLandingPage } from "./agent-landing"
import { MarketingShell } from "./marketing-shell"

const meta = {
  title: "CMS/Agent landing",
  component: AgentLandingPage,
  args: { page: agentLandingContent["whatsapp-sales"] },
  parameters: {
    layout: "fullscreen",
    // Agent landings ship in light mode only.
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
      <AgentLandingPage {...args} />
    </MarketingShell>
  ),
} satisfies Meta<typeof AgentLandingPage>

export default meta
type Story = StoryObj<typeof meta>

// Waits for the opening message so the accessibility scan sees settled bubbles.
async function firstMessageSettles(canvasElement: HTMLElement, text: RegExp) {
  const message = await within(
    within(canvasElement).getByRole("log")
  ).findByText(text)
  await waitFor(() =>
    expect(getComputedStyle(message.closest("[data-from]")!).opacity).toBe("1")
  )
}

export const WhatsAppSales: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const link of canvas.getAllByRole("link", {
      name: /demo.*opens WhatsApp/i,
    }))
      await expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("https://wa.me/551151995330?text=")
      )
    await expect(canvas.getByText("+55 11 5199-5330")).toBeInTheDocument()
    await expect(
      canvas.getAllByRole("listitem", { current: "step" })
    ).toHaveLength(1)
    await expect(
      within(
        canvas.getByRole("region", { name: /Everything behind/ })
      ).getAllByRole("listitem")
    ).toHaveLength(10)
    const second = canvas.getByRole("button", {
      name: "How does a sales agent know my products?",
    })
    await expect(second).toHaveAttribute("aria-expanded", "false")
    // A plain click keeps the scroll position, so the story stays on its first chapter.
    second.click()
    await waitFor(() => expect(second).toHaveAttribute("aria-expanded", "true"))
    const firstMessage = await within(canvas.getByRole("log")).findByText(
      /Running shoes/
    )
    // Let the entrance animations settle before the accessibility scan.
    await waitFor(() =>
      expect(
        getComputedStyle(firstMessage.closest("[data-from]")!).opacity
      ).toBe("1")
    )
    await waitFor(() =>
      expect(
        getComputedStyle(
          canvas.getByRole("region", { name: second.textContent! })
        ).opacity
      ).toBe("1")
    )
  },
}

export const WebsiteSales: Story = {
  args: { page: agentLandingContent["website-sales"] },
  play: ({ canvasElement }) => firstMessageSettles(canvasElement, /Aurora/),
}

export const WhatsAppSupport: Story = {
  args: { page: agentLandingContent["whatsapp-support"] },
  play: ({ canvasElement }) =>
    firstMessageSettles(canvasElement, /says delivered/),
}

export const WebsiteSupport: Story = {
  args: { page: agentLandingContent["website-support"] },
  play: ({ canvasElement }) => firstMessageSettles(canvasElement, /Volt Air/),
}

export const ProductGuidance: Story = {
  args: { page: agentLandingContent["product-guidance"] },
  play: ({ canvasElement }) =>
    firstMessageSettles(canvasElement, /bank transactions/),
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
