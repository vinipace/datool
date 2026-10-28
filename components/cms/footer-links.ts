import { demoHref } from "@/lib/marketing/demo"
import {
  productFeatureHref,
  productFeatures,
  productPillars,
} from "@/lib/marketing/product"
import { agentPages } from "./agent-pages"

type FooterLink = { href: string; label: string; external?: boolean }

// Every public marketing and docs page, so crawlers and visitors can reach
// each one from any page.
export const footerColumns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      ...productPillars.map((pillar) => ({
        href: `/product/${pillar.slug}`,
        label: pillar.name,
      })),
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    title: "Features",
    links: productFeatures.map((feature) => ({
      href: productFeatureHref(feature),
      label: feature.name,
    })),
  },
  {
    title: "Agents",
    links: agentPages.map((page) => ({ href: page.href, label: page.name })),
  },
  {
    title: "Docs",
    links: [
      { href: "/docs", label: "Documentation" },
      { href: "/docs/get-started/concepts", label: "Core concepts" },
      { href: "/docs/get-started/first-trace", label: "Send your first trace" },
      {
        href: "/docs/get-started/first-evaluation",
        label: "Run your first evaluation",
      },
      { href: "/docs/get-started/first-prompt", label: "Managed prompts" },
      { href: "/docs/guides/whatsapp", label: "WhatsApp" },
      { href: "/docs/guides/playground", label: "Playground" },
      { href: "/docs/guides/dashboards", label: "Dashboards" },
      { href: "/docs/guides/alerts", label: "Alerts" },
      { href: "/docs/guides/reviews", label: "Reviews and human scores" },
      { href: "/docs/evaluation/datasets", label: "Datasets" },
      { href: "/docs/evaluation/scorers", label: "Scorers" },
      { href: "/docs/evaluation/ci", label: "CI evaluation gates" },
      { href: "/docs/self-hosting", label: "Self-hosting" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs/tracing/openai", label: "OpenAI" },
      { href: "/docs/tracing/ai-sdk", label: "AI SDK" },
      { href: "/docs/tracing/langgraph", label: "LangGraph and LangChain" },
      { href: "/docs/tracing/hermes", label: "Hermes Agent" },
      { href: "/docs/guides/providers", label: "Model providers" },
      { href: "/docs/reference/sdk", label: "TypeScript SDK" },
      { href: "/docs/reference/python-sdk", label: "Python SDK" },
      { href: "/docs/reference/api", label: "REST API" },
      { href: "/docs/reference/cli", label: "CLI" },
      { href: "/docs/reference/mcp", label: "MCP" },
      { href: "/docs/reference/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/faq", label: "FAQ" },
      { href: demoHref, label: "Request a demo", external: true },
      {
        href: "https://github.com/vinipace/datool",
        label: "GitHub",
        external: true,
      },
      { href: "/docs/privacy", label: "Privacy" },
      { href: "/docs/data-processing", label: "Data processing" },
      { href: "/docs/retention", label: "Retention and deletion" },
      { href: "/docs/subprocessors", label: "Subprocessors" },
      { href: "/docs/licensing", label: "Licensing" },
      { href: "/sign-up", label: "Sign up" },
      { href: "/sign-in", label: "Log in" },
    ],
  },
]
