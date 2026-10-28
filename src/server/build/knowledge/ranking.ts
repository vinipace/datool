import { createGateway } from "@ai-sdk/gateway"
import { rerank } from "ai"

import {
  KNOWLEDGE_LIMITS,
  type KnowledgeSearchResult,
} from "@/src/lib/build/knowledge"
import { GATEWAY_PROVIDER } from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import type { BuildContext } from "../context"

const rerankingModel = "cohere/rerank-v4-fast"
const deadlineMs = 3_000

function pageIdentity(result: KnowledgeSearchResult) {
  if (typeof result.metadata.url !== "string") return null
  try {
    const url = new URL(result.metadata.url)
    const markdown = /\.md$/i.test(url.pathname)
    url.pathname = url.pathname.replace(/\.md$/i, "").replace(/\/$/, "") || "/"
    url.hash = ""
    return { url: url.href, markdown }
  } catch {
    return null
  }
}

/**
 * Collapse identical passages, including whitespace-only differences. A URL
 * alone is never a duplicate key: distinct passages on one page remain useful.
 * Keep the original ranking position and prefer the matching HTML citation
 * over its Markdown alternative without synthesizing a new source URL.
 */
function deduplicate(candidates: KnowledgeSearchResult[]) {
  const unique = new Map<string, KnowledgeSearchResult>()
  for (const candidate of candidates) {
    const key = candidate.content.normalize("NFC").replace(/\s+/gu, " ").trim()
    if (!key) continue
    const previous = unique.get(key)
    if (!previous) {
      unique.set(key, candidate)
      continue
    }
    const previousPage = pageIdentity(previous)
    const candidatePage = pageIdentity(candidate)
    if (
      previousPage?.markdown &&
      candidatePage &&
      !candidatePage.markdown &&
      previousPage.url === candidatePage.url
    )
      unique.set(key, { ...candidate, score: previous.score })
  }
  return [...unique.values()]
}

/**
 * Only previously retrieved, tenant-scoped chunks may be selected. Provider
 * output can reorder those chunks but cannot supply content or citations.
 * Failure retains the deduplicated hybrid order, including its original scores.
 */
export async function rankKnowledgeCandidates(
  context: BuildContext,
  input: {
    query: string
    candidates: KnowledgeSearchResult[]
    limit: number
    signal?: AbortSignal
  }
): Promise<KnowledgeSearchResult[]> {
  const candidates = deduplicate(
    input.candidates.slice(0, KNOWLEDGE_LIMITS.maxResults * 2)
  )
  const limit = Math.min(input.limit, candidates.length)
  const fallback = candidates.slice(0, limit)
  if (candidates.length < 2 || input.signal?.aborted) return fallback

  try {
    const apiKey = await getProjectProviderKey(
      context.projectId,
      GATEWAY_PROVIDER,
      context.database
    )
    const result = await rerank({
      model: createGateway({ apiKey }).rerankingModel(rerankingModel),
      query: input.query.slice(0, KNOWLEDGE_LIMITS.maxQueryCharacters),
      documents: candidates.map((candidate) => {
        const title = candidate.metadata.title
        return typeof title === "string" && title.trim()
          ? `${title.slice(0, 300)}\n\n${candidate.content}`
          : candidate.content
      }),
      topN: limit,
      maxRetries: 0,
      abortSignal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMs)])
        : AbortSignal.timeout(deadlineMs),
    })
    // Reject partial, duplicated or invalid rankings as a whole. Never combine
    // provider relevance scores with hybrid scores to fill a malformed response.
    const seen = new Set<number>()
    if (
      result.ranking.length !== limit ||
      result.ranking.some(({ originalIndex, score }) => {
        if (
          !Number.isInteger(originalIndex) ||
          originalIndex < 0 ||
          originalIndex >= candidates.length ||
          !Number.isFinite(score) ||
          seen.has(originalIndex)
        )
          return true
        seen.add(originalIndex)
        return false
      })
    )
      return fallback
    return result.ranking.map(({ originalIndex, score }) => ({
      ...candidates[originalIndex],
      score,
    }))
  } catch {
    // Missing credentials, timeouts and provider failures must not break a
    // working retrieval. Do not expose provider payloads or project credentials.
    return fallback
  }
}
