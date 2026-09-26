import { DATOOL_PROVIDER, DATOOL_SCORER_MODEL } from "./execution-credits"
export const GATEWAY_PROVIDER = "vercel-ai-gateway" as const
export const TYPESAFE_PROVIDER = "typesafe-ai" as const
export const OPENAI_PROVIDER = "openai" as const
export const MODEL_PROVIDER_IDS = [
  DATOOL_PROVIDER,
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  TYPESAFE_PROVIDER,
] as const
export type ModelProvider = (typeof MODEL_PROVIDER_IDS)[number]

export const modelProviders = {
  [DATOOL_PROVIDER]: {
    baseUrl: "https://api.openai.com/v1",
    name: "Datool",
    logo: "datool",
    kind: "Included execution",
    description: "Scoring with your organization’s execution credits",
    keyLabel: "Managed by Datool",
    docsUrl: "/usage",
  },
  [GATEWAY_PROVIDER]: {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    name: "Vercel AI Gateway",
    logo: "vercel",
    kind: "AI Gateway",
    description: "Models from multiple providers",
    keyLabel: "AI Gateway API key",
    docsUrl: "https://vercel.com/docs/ai-gateway/authentication-and-byok",
  },
  [TYPESAFE_PROVIDER]: {
    baseUrl: "https://api.typesafe.ai/v1",
    name: "TypeSafe AI",
    logo: "typesafe-ai",
    kind: "Evaluation",
    description: "Direct Jev evaluations",
    keyLabel: "TypeSafe AI API key",
    docsUrl: "https://docs.typesafe.ai/api",
  },
  [OPENAI_PROVIDER]: {
    baseUrl: "https://api.openai.com/v1",
    name: "OpenAI",
    logo: "openai",
    kind: "AI Provider",
    description: "Direct access to OpenAI models",
    keyLabel: "OpenAI API key",
    docsUrl: "https://platform.openai.com/api-keys",
  },
} as const

export type ProviderStatus = {
  id: ModelProvider
  name: string
  configured: boolean
  updatedAt: string | null
}

export type ModelOption = {
  id: string
  /** Credential provider, distinct from the model's creator. */
  provider?: ModelProvider
  name: string
  creator: string
  type: string
  contextWindow?: number
  description?: string
  maxOutputTokens?: number
  pricing?: {
    input?: string
    output?: string
    cacheRead?: string
    inputTiers?: { cost: string; min: number; max?: number }[]
    outputTiers?: { cost: string; min: number; max?: number }[]
  }
  modalities?: { input: string[]; output: string[] }
  tags: string[]
}

/** Picker identity includes the credential provider; API model IDs stay unchanged. */
export const modelOptionValue = (
  model: Pick<ModelOption, "id" | "provider">
) => (model.provider ? `${model.provider}/${model.id}` : model.id)

/** Gateway prices are USD per token; zero is a valid free rate. */
export function modelTokenPrice(rate?: string, tiers?: { cost: string }[]) {
  const rates = (tiers?.length ? tiers.map((tier) => tier.cost) : [rate])
    .filter(
      (value): value is string => value !== undefined && value.trim() !== ""
    )
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (!rates.length) return "Not available"
  const price = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(value * 1_000_000)
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  return `${price(min)}${min !== max ? `–${price(max)}` : ""} / million tokens`
}

export type ModelCatalog = {
  models: ModelOption[]
  fetchedAt: string
  stale: boolean
  datoolModel?: boolean
}

/** TypeSafe's documented direct model alias; independent of Gateway discovery. */
export const typeSafeModels: ModelOption[] = [
  {
    id: "jev-latest",
    name: "Jev",
    creator: TYPESAFE_PROVIDER,
    type: "evaluation",
    description:
      "Evaluates text evidence and returns choices and probabilities using your TypeSafe AI key.",
    modalities: { input: ["text"], output: ["text"] },
    tags: [],
  },
]

/** Reuse Gateway metadata without another catalog request or a separate model list. */
export const datoolScorerModel = {
  id: DATOOL_SCORER_MODEL,
  provider: DATOOL_PROVIDER,
  name: "Datool Scorer Model",
  creator: "datool",
  type: "language",
  tags: ["Included credits"],
  description:
    "GPT-6 Luna · Uses your organization’s execution credits. No API key needed.",
  contextWindow: 16000,
  maxOutputTokens: 4096,
  modalities: { input: ["text"], output: ["text"] },
  pricing: { input: "0.0000001", output: "0.0000005", cacheRead: "0.00000001" },
}
export function projectModels(
  gatewayModels: ModelOption[],
  datoolModel = false
) {
  return [
    ...(datoolModel ? [datoolScorerModel] : []),
    ...gatewayModels.map((model) => ({ ...model, provider: GATEWAY_PROVIDER })),
    ...gatewayModels
      .filter(
        (model) =>
          model.creator === OPENAI_PROVIDER &&
          model.id.startsWith("openai/") &&
          !model.id.endsWith("-fast") &&
          !model.id.startsWith("openai/gpt-oss-")
      )
      .map((model) => ({
        ...model,
        // Gateway uses a different alias for OpenAI's GPT-5.1 model.
        id:
          model.id === "openai/gpt-5.1-thinking"
            ? "gpt-5.1"
            : model.id.slice("openai/".length),
        provider: OPENAI_PROVIDER,
      })),
    ...typeSafeModels.map((model) => ({
      ...model,
      provider: TYPESAFE_PROVIDER,
    })),
  ]
}

export const isOpenAIModelId = (value: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)

export type ModelPriceIndicator = {
  fraction: number
  level: "Free" | "Cheap" | "Medium" | "Expensive"
}

/** Relative catalog price, using an equal input/output mix and the highest tier. */
export function modelPriceIndicators(models: ModelOption[]) {
  const rate = (base?: string, tiers?: { cost: string }[]) => {
    const values = (tiers?.length ? tiers.map((tier) => tier.cost) : [base])
      .filter(
        (value): value is string => value !== undefined && value.trim() !== ""
      )
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0)
    return values.length ? Math.max(...values) : undefined
  }
  const costs = models.map((model) => {
    const input = rate(model.pricing?.input, model.pricing?.inputTiers)
    const output = rate(model.pricing?.output, model.pricing?.outputTiers)
    return {
      id: model.id,
      cost:
        input === undefined || output === undefined
          ? undefined
          : (input + output) * 500_000,
    }
  })
  const maximum = Math.max(0, ...costs.map(({ cost }) => cost ?? 0))
  return new Map<string, ModelPriceIndicator | undefined>(
    costs.map(({ id, cost }) => {
      if (cost === undefined) return [id, undefined]
      // $0.10 per million is the smoothing unit; outliers do not flatten ordinary prices.
      const fraction =
        cost === 0
          ? 0
          : Math.max(0.08, Math.log1p(cost / 0.1) / Math.log1p(maximum / 0.1))
      return [
        id,
        {
          fraction,
          level:
            cost === 0
              ? "Free"
              : fraction < 1 / 3
                ? "Cheap"
                : fraction < 2 / 3
                  ? "Medium"
                  : "Expensive",
        },
      ]
    })
  )
}

export const isGatewayModelId = (value: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
