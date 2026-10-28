"use client"
import { useLivePreview } from "@payloadcms/live-preview-react"
import type { AgentLanding, Page, FaqPage, Faq } from "@/payload-types"
import { MarketingShell } from "./marketing-shell"
import { HomePage } from "./home-page"
import { PageBlocks } from "./page-blocks"
import { FAQAnswer } from "./faq-content"
import { ProductPillarPage } from "./product-page"
import { getProductPillar } from "@/lib/marketing/product"
import { richText } from "@/cms/seed-content"
import { agentLandingContent } from "@/cms/agent-landing-content"
import { AgentLandingPage } from "./agent-landing"

const placeholder: Page = {
  id: 0,
  title: "Page preview",
  slug: "preview",
  layout: [],
  createdAt: "",
  updatedAt: "",
}
const faqPlaceholder: FaqPage = { id: 0, title: "FAQ preview" }
const answerPlaceholder: Faq = {
  id: 0,
  question: "Question preview",
  slug: "preview",
  answer: richText("Your answer will appear here."),
  createdAt: "",
  updatedAt: "",
}
export function LivePreview({
  type,
  serverURL,
}: {
  type: "pages" | "landing-page" | "faq-page" | "faqs" | "agent-landings"
  serverURL: string
}) {
  const { data } = useLivePreview<Page | FaqPage | Faq | AgentLanding>({
    initialData:
      type === "agent-landings"
        ? {
            ...agentLandingContent["whatsapp-sales"],
            // Live preview replaces these with the edited document's questions.
            faq: { ...agentLandingContent["whatsapp-sales"].faq, items: [] },
            id: 0,
            createdAt: "",
            updatedAt: "",
          }
        : type === "faqs"
          ? answerPlaceholder
          : type === "faq-page"
            ? faqPlaceholder
            : placeholder,
    serverURL,
    depth: 2,
    apiRoute: "/cms/api",
  })
  const pillar =
    "slug" in data && data.slug.startsWith("product-")
      ? getProductPillar(data.slug.slice(8))
      : undefined
  return (
    <MarketingShell>
      {"hero" in data ? (
        <AgentLandingPage page={data} />
      ) : "question" in data ? (
        <FAQAnswer faq={data} />
      ) : "layout" in data && pillar ? (
        <ProductPillarPage page={data} pillar={pillar} preview />
      ) : "layout" in data && type === "landing-page" ? (
        <HomePage blocks={data.layout ?? []} preview />
      ) : "layout" in data ? (
        <>
          {data.layout?.[0]?.blockType !== "hero" && (
            <h1 className="pt-16 text-4xl font-semibold">{data.title}</h1>
          )}
          <PageBlocks blocks={data.layout ?? []} preview />
        </>
      ) : (
        <div className="py-24">
          <h1 className="text-5xl font-semibold">{data.title}</h1>
          <p className="mt-6 text-lg text-foreground-muted">
            {data.introduction}
          </p>
        </div>
      )}
    </MarketingShell>
  )
}
