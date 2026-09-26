/** Public feature navigation; page copy lives in Payload's Pages collection. */
export const productPillars = [
  {
    slug: "build",
    name: "Build",
    icon: "playground",
    summary: "From your first prompt to a working AI application.",
    docs: "/docs/guides/playground",
  },
  {
    slug: "observe",
    name: "Observe",
    icon: "traces",
    summary: "See every request, decision, and tool call in context.",
    docs: "/docs/tracing/investigation",
  },
  {
    slug: "evaluate",
    name: "Evaluate",
    icon: "evals",
    summary: "Test changes against real examples and human judgment.",
    docs: "/docs/evaluation/runs",
  },
  {
    slug: "discover",
    name: "Discover",
    icon: "dashboards",
    summary: "Find patterns in quality, performance, and cost.",
    docs: "/docs/guides/dashboards",
  },
] as const
export type ProductPillar = (typeof productPillars)[number]
export const getProductPillar = (slug: string) =>
  productPillars.find((pillar) => pillar.slug === slug)
export const productFeatures = [
  {
    slug: "traces",
    name: "Traces",
    group: "Observe",
    icon: "traces",
    summary: "Follow every step of a request.",
    docs: "/docs/tracing/investigation",
  },
  {
    slug: "agents",
    name: "Agents",
    group: "Observe",
    icon: "agents",
    summary: "Understand agent behavior across runs.",
    docs: "/docs/get-started/concepts",
  },
  {
    slug: "workflows",
    name: "Workflows",
    group: "Observe",
    icon: "workflows",
    summary: "See how each workflow performs.",
    docs: "/docs/tracing/investigation",
  },
  {
    slug: "sessions",
    name: "Sessions",
    group: "Observe",
    icon: "sessions",
    summary: "Keep related requests in context.",
    docs: "/docs/get-started/concepts",
  },
  {
    slug: "playground",
    name: "Playground",
    group: "Build",
    icon: "playground",
    summary: "Try inputs against your connected app.",
    docs: "/docs/guides/playground",
  },
  {
    slug: "prompts",
    name: "Prompts",
    group: "Build",
    icon: "prompts",
    summary: "Version the instructions behind your AI.",
    docs: "/docs/guides/prompts",
  },
  {
    slug: "integrations",
    name: "SDK, CLI & MCP",
    group: "Build",
    icon: "mcpConnections",
    summary: "Bring Datool into your own tools.",
    docs: "/docs/reference/sdk",
  },
  {
    slug: "datasets",
    name: "Datasets",
    group: "Evaluate",
    icon: "datasets",
    summary: "Turn real examples into repeatable tests.",
    docs: "/docs/evaluation/datasets",
  },
  {
    slug: "scorers",
    name: "Scorers",
    group: "Evaluate",
    icon: "scorers",
    summary: "Define what a good answer looks like.",
    docs: "/docs/evaluation/scorers",
  },
  {
    slug: "evaluations",
    name: "Evaluations",
    group: "Evaluate",
    icon: "evals",
    summary: "Compare changes on the same evidence.",
    docs: "/docs/evaluation/runs",
  },
  {
    slug: "reviews",
    name: "Reviews",
    group: "Evaluate",
    icon: "reviews",
    summary: "Bring human judgment into the loop.",
    docs: "/docs/guides/reviews",
  },
  {
    slug: "human-scores",
    name: "Human scores",
    group: "Evaluate",
    icon: "humanScores",
    summary: "Give reviewers a shared set of criteria.",
    docs: "/docs/guides/reviews",
  },
  {
    slug: "dashboards",
    name: "Dashboards",
    group: "Discover",
    icon: "dashboards",
    summary: "Watch quality, latency, usage, and cost.",
    docs: "/docs/guides/dashboards",
  },
  {
    slug: "alerts",
    name: "Alerts",
    group: "Discover",
    icon: "alerts",
    summary: "Know when a workflow needs attention.",
    docs: "/docs/guides/alerts",
  },
] as const

export type ProductFeature = (typeof productFeatures)[number]
export const getProductFeature = (slug: string) =>
  productFeatures.find((feature) => feature.slug === slug)
export const productPageSlug = (slug: string) => `product-${slug}`

export function productFeatureHref(feature: ProductFeature) {
  const pillar = productPillars.find((item) => item.name === feature.group)!
  return `/product/${pillar.slug}#${feature.slug}`
}
