import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, type LanguageModel } from "ai"

import {
  agentProviderSchema,
  type AgentProvider,
} from "@/src/lib/build/contracts"
import { GATEWAY_PROVIDER, OPENAI_PROVIDER } from "@/src/lib/model-providers"
import {
  KNOWLEDGE_LIMITS,
  normalizeKnowledgeText,
  type KnowledgeQueryExpander,
} from "@/src/lib/build/knowledge"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import type { BuildContext } from "../context"

export type KnowledgeQueryExpansionOptions = {
  /** The agent's configured model, including an optional provider prefix. */
  model: string
  /** Agent configuration provider. `project` uses the gateway project key. */
  provider?: AgentProvider
  /** Test or platform override; production resolves the project's provider key. */
  resolveModel?: (
    context: BuildContext,
    model: string,
    provider: AgentProvider
  ) => Promise<LanguageModel>
  generateText?: typeof generateText
  fetch?: typeof fetch
  signal?: AbortSignal
}

function modelId(
  model: string,
  provider: typeof GATEWAY_PROVIDER | typeof OPENAI_PROVIDER
) {
  const prefix = `${provider}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

async function resolveLanguageModel(
  context: BuildContext,
  options: KnowledgeQueryExpansionOptions,
  provider: AgentProvider
) {
  if (options.resolveModel)
    return options.resolveModel(context, options.model, provider)
  const credentialProvider =
    provider === "openai" ? OPENAI_PROVIDER : GATEWAY_PROVIDER
  const apiKey = await getProjectProviderKey(
    context.projectId,
    credentialProvider,
    context.database
  )
  const selectedModel = modelId(options.model.trim(), credentialProvider)
  return credentialProvider === OPENAI_PROVIDER
    ? createOpenAI({ apiKey, fetch: options.fetch }).chat(selectedModel)
    : createGateway({ apiKey, fetch: options.fetch }).languageModel(
        selectedModel
      )
}

function parseExpandedQueries(
  text: string,
  maxQueries: number,
  maxCharacters: number
) {
  const bounded = text.slice(0, maxQueries * (maxCharacters + 32))
  let values: unknown = bounded
  try {
    const parsed: unknown = JSON.parse(
      bounded
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
    )
    if (Array.isArray(parsed)) values = parsed
    else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { queries?: unknown }).queries)
    )
      values = (parsed as { queries: unknown[] }).queries
  } catch {
    values = bounded.split(/\r?\n/u)
  }
  const candidates = Array.isArray(values) ? values : [values]
  const result: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const query = normalizeKnowledgeText(
      candidate
        .replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "")
        .replace(/^['"]|['"]$/gu, "")
    ).slice(0, maxCharacters)
    const key = query.toLocaleLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    result.push(query)
    if (result.length >= maxQueries) break
  }
  return result
}

/**
 * Create the optional model-backed query expansion hook used after lexical
 * retrieval misses. The model only proposes search strings; retrieval still
 * selects indexed chunks and returns their original source provenance.
 */
export function createKnowledgeQueryExpander(
  context: BuildContext,
  options: KnowledgeQueryExpansionOptions
): KnowledgeQueryExpander {
  const provider = agentProviderSchema.parse(options.provider ?? "project")
  return async ({ query, maxQueries, maxCharacters }) => {
    const boundedMaxQueries = Math.min(
      Math.max(Math.floor(maxQueries), 1),
      KNOWLEDGE_LIMITS.maxQueryExpansions
    )
    const boundedMaxCharacters = Math.min(
      Math.max(Math.floor(maxCharacters), 1),
      KNOWLEDGE_LIMITS.maxQueryExpansionCharacters
    )
    const model = await resolveLanguageModel(context, options, provider)
    const generate = options.generateText ?? generateText
    const result = await generate({
      model,
      system: [
        "You expand a customer support search query for a knowledge base.",
        "Return only alternate search queries, one per line.",
        "Do not answer the customer, explain the rewrite, add labels, or invent facts.",
        `Return at most ${boundedMaxQueries} queries, each at most ${boundedMaxCharacters} characters.`,
      ].join("\n"),
      prompt: query.slice(0, KNOWLEDGE_LIMITS.maxQueryCharacters),
      temperature: 0,
      maxOutputTokens: Math.min(128, boundedMaxQueries * 48),
      maxRetries: 0,
      abortSignal: options.signal,
    } as never)
    return parseExpandedQueries(
      result.text,
      boundedMaxQueries,
      boundedMaxCharacters
    )
  }
}
