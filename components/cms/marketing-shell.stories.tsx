import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { Faq } from "@/payload-types"
import { faqContent, landingBlocks, richText } from "@/cms/seed-content"
import { ContentDisclosure } from "@/components/ui/content-disclosure"
import { AdminLogin } from "./admin-login"
import { AdminLogout } from "./admin-logout"
import { FAQAccordion } from "./faq-accordion"
import { FAQAnswer, FAQAnswerContent } from "./faq-content"
import { LivePreview } from "./live-preview"
import { MarketingShell } from "./marketing-shell"
import { RequestStory } from "./landing-visuals"
import { PageBlocks } from "./page-blocks"
import { StructuredData } from "./structured-data"
import { productPillars } from "@/lib/marketing/product"

const faqs: Faq[] = faqContent.map((item, index) => ({
  ...item,
  id: index + 1,
  answer: richText(item.answer),
  shortAnswer: index === 0 ? "Understand and improve your AI." : undefined,
  _status: "published",
  createdAt: "2026-09-17T00:00:00Z",
  updatedAt: "2026-09-17T00:00:00Z",
}))
const blocks = landingBlocks(faqs.map((faq) => faq.id)).map((block) =>
  block.blockType === "faq" ? { ...block, items: faqs } : block
)
const relatedPages = [
  {
    title: "How it works",
    href: "/pages/how-it-works",
    layout: blocks,
    _status: "published" as const,
  },
]

const meta = {
  title: "CMS/Marketing",
  component: MarketingShell,
  args: { children: null },
  parameters: { layout: "fullscreen" },
  render: () => (
    <MarketingShell>
      <StructuredData
        data={{ "@context": "https://schema.org", "@type": "WebPage" }}
      />
      <PageBlocks blocks={blocks} landing />
    </MarketingShell>
  ),
} satisfies Meta<typeof MarketingShell>

export default meta
type Story = StoryObj<typeof meta>

export const LandingPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "02 Evaluate" }))
    await expect(
      canvas.getByText("An unexpected answer becomes a test.", {
        selector: "p",
      })
    ).toBeVisible()
    const improve = canvas.getByRole("button", { name: "03 Improve" })
    improve.focus()
    await userEvent.keyboard("{Enter}")
    await expect(improve).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByText("See what your next change changes.", { selector: "p" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "01 Trace" }))
    await expect(
      canvas.getByText("Every step. Nothing hidden.", { selector: "p" })
    ).toBeVisible()
    await userEvent.click(canvas.getByText(faqs[0].question))
    await expect(canvas.getByText(faqContent[0].answer)).toBeVisible()
    await expect(canvas.queryByText("Read full answer")).not.toBeInTheDocument()
  },
}

export const NarrowLanding: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
}

export const ProductNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole("button", { name: "Product" })
    trigger.focus()
    await userEvent.keyboard("{Enter}")
    const menu = within(
      await within(document.body).findByRole("menu", { name: "Product" })
    )
    for (const feature of productPillars) {
      await expect(
        menu.getByRole("menuitem", {
          name: `${feature.name} ${feature.summary}`,
        })
      ).toHaveAttribute("href", `/product/${feature.slug}`)
    }
    await expect(menu.getAllByRole("menuitem")).toHaveLength(4)
    await userEvent.keyboard("{Escape}")
    await expect(trigger).toHaveFocus()
    await expect(canvas.getByRole("link", { name: "Pricing" })).toHaveAttribute(
      "href",
      "/pricing"
    )
    await expect(canvas.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "/docs"
    )
  },
}

export const WorkflowAutoplay: Story = {
  render: () => (
    <div className="max-w-xl p-6">
      <RequestStory stageDurationMs={800} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trace = canvas.getByRole("button", { name: "01 Trace" })
    const evaluate = canvas.getByRole("button", { name: "02 Evaluate" })
    const improve = canvas.getByRole("button", { name: "03 Improve" })
    for (const stage of [evaluate, improve, trace]) {
      await waitFor(
        () => expect(stage).toHaveAttribute("aria-pressed", "true"),
        {
          timeout: 1800,
        }
      )
    }
    await userEvent.click(evaluate)
    await expect(evaluate).toHaveAttribute("aria-pressed", "true")
    await waitFor(
      () => expect(improve).toHaveAttribute("aria-pressed", "true"),
      {
        timeout: 1800,
      }
    )
  },
}

export const WorkflowTimerRestart: Story = {
  render: WorkflowAutoplay.render,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trace = canvas.getByRole("button", { name: "01 Trace" })
    await userEvent.click(trace)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await userEvent.click(trace)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(trace).toHaveAttribute("aria-pressed", "true")
    await waitFor(
      () =>
        expect(
          canvas.getByRole("button", { name: "02 Evaluate" })
        ).toHaveAttribute("aria-pressed", "true"),
      { timeout: 1800 }
    )
  },
}

export const AnswerWithConnections: Story = {
  render: () => (
    <MarketingShell>
      <FAQAnswer faq={faqs[0]} relatedPages={relatedPages} />
    </MarketingShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("link", { name: faqs[1].question })
    ).toHaveAttribute("href", `/faq/${faqs[1].slug}`)
    await expect(
      canvas.getByRole("link", { name: "How it works" })
    ).toHaveAttribute("href", "/pages/how-it-works")
  },
}

export const ExpandedQuestion: Story = {
  parameters: { nextjs: { navigation: { pathname: `/faq/${faqs[0].slug}` } } },
  render: () => (
    <MarketingShell>
      <h1 className="py-12 text-4xl">Frequently asked questions</h1>
      <FAQAccordion
        items={faqs.map((faq) => ({
          slug: faq.slug,
          question: faq.question,
          content: (
            <FAQAnswerContent faq={faq} relatedPages={relatedPages} inline />
          ),
        }))}
      />
    </MarketingShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: faqs[0].question })
    ).toHaveAttribute("aria-expanded", "true")
    await expect(canvas.getByText(faqContent[0].answer)).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: faqs[1].question })
    ).toHaveAttribute("aria-expanded", "false")
  },
}

function DisclosureExample() {
  const [open, setOpen] = useState(false)
  return (
    <ContentDisclosure
      id="example"
      href="/faq/example"
      title="How do answers open?"
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <p>The full answer stays on this page.</p>
    </ContentDisclosure>
  )
}

export const KeyboardDisclosure: Story = {
  render: () => <DisclosureExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole("button", { name: "How do answers open?" })
    trigger.focus()
    await userEvent.keyboard(" ")
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(
      canvas.getByText("The full answer stays on this page.")
    ).toBeVisible()
    await userEvent.keyboard("{Enter}")
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
  },
}

export const PagePreview: Story = {
  render: () => <LivePreview type="pages" serverURL={window.location.origin} />,
}
export const FAQPreview: Story = {
  render: () => <LivePreview type="faqs" serverURL={window.location.origin} />,
}
export const FAQIntroductionPreview: Story = {
  render: () => (
    <LivePreview type="faq-page" serverURL={window.location.origin} />
  ),
}

export const EditorSignInFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-in/social", () =>
          HttpResponse.json(
            { message: "Editor access is required." },
            { status: 403 }
          )
        ),
      ],
    },
  },
  render: () => <AdminLogin />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Continue with Google" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Editor access is required."
    )
    await expect(
      canvas.getByRole("button", { name: "Continue with Google" })
    ).toBeEnabled()
  },
}

export const EditorSignOutFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/auth/sign-out", () =>
          HttpResponse.json(
            { message: "Session unavailable." },
            { status: 500 }
          )
        ),
      ],
    },
  },
  render: () => <AdminLogout />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Sign out of Datool" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to sign out."
    )
    await expect(
      canvas.getByRole("button", { name: "Sign out of Datool" })
    ).toBeEnabled()
  },
}
