import { http, HttpResponse } from "msw"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  TYPESAFE_PROVIDER,
  type ModelOption,
} from "@/src/lib/model-providers"

export const gatewayModels: ModelOption[] = [
  {
    id: "typesafe-ai/jev",
    name: "Jev",
    creator: "typesafe-ai",
    type: "evaluation",
    tags: [],
    description:
      "Evaluates text evidence against typed questions and returns choices and probabilities.",
    pricing: { input: "0.000000042", output: "0" },
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    creator: "anthropic",
    type: "language",
    tags: ["reasoning"],
    description: "A capable model for reasoning and coding tasks.",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    pricing: { input: "0.000003", output: "0.000015" },
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 mini",
    creator: "openai",
    type: "language",
    tags: ["tool-use"],
    description: "A fast model that balances intelligence and cost.",
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    pricing: {
      input: "0.0000004",
      output: "0.0000016",
      cacheRead: "0.0000001",
    },
  },
  {
    id: "openai/text-embedding-3-small",
    name: "Text embedding 3 small",
    creator: "openai",
    type: "embedding",
    tags: [],
  },
]
export const providerStatus = (
  configured = true,
  typesafeConfigured = false,
  openaiConfigured = false
) => ({
  providers: [
    {
      id: OPENAI_PROVIDER,
      name: "OpenAI",
      configured: openaiConfigured,
      updatedAt: openaiConfigured ? "2026-09-18T00:00:00Z" : null,
    },
    {
      id: GATEWAY_PROVIDER,
      name: "Vercel AI Gateway",
      configured,
      updatedAt: configured ? "2026-09-16T00:00:00Z" : null,
    },
    {
      id: TYPESAFE_PROVIDER,
      name: "TypeSafe AI",
      configured: typesafeConfigured,
      updatedAt: typesafeConfigured ? "2026-09-17T00:00:00Z" : null,
    },
  ],
})
export const modelProviderHandlers = [
  http.get(
    "https://models.dev/logos/:provider.svg",
    () =>
      new HttpResponse(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg>',
        { headers: { "content-type": "image/svg+xml" } }
      )
  ),
  http.get("/api/projects/:projectId/providers", () =>
    HttpResponse.json(providerStatus())
  ),
  http.get("/api/projects/:projectId/providers/models", () =>
    HttpResponse.json({
      models: gatewayModels,
      fetchedAt: "2026-09-16T00:00:00Z",
      stale: false,
    })
  ),
]
