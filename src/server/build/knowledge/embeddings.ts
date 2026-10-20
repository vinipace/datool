import { createHash } from "node:crypto"
import { createGateway } from "@ai-sdk/gateway"
import { createOpenAI } from "@ai-sdk/openai"
import { embedMany } from "ai"
import { sql } from "drizzle-orm"

import { GATEWAY_PROVIDER, OPENAI_PROVIDER } from "@/src/lib/model-providers"
import { getProjectProviderKey } from "@/src/server/model-providers/store"
import type { BuildContext } from "../context"

// The profile includes the model, dimensions and input format. Only vectors
// from the same profile may be compared or reused across source refreshes.
export const KNOWLEDGE_EMBEDDING_PROFILE =
  "openai/text-embedding-3-small:1536:v1"
export const KEYWORD_KNOWLEDGE_NOTICE =
  "Keyword search only. Connect AI Gateway or OpenAI in project settings to enable semantic search."
const dimensions = 1536
const batchSize = 64

type EmbeddingChunk = {
  content: string
  metadata: Record<string, unknown>
}

function embeddingText(chunk: EmbeddingChunk) {
  const title = chunk.metadata.title
  return typeof title === "string" && title.trim()
    ? `${title.slice(0, 300)}\n\n${chunk.content}`
    : chunk.content
}

function contentKey(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function validVector(value: number[]) {
  if (
    value.length !== dimensions ||
    !value.every(Number.isFinite) ||
    !value.some((coordinate) => coordinate !== 0)
  )
    throw new Error(
      "The knowledge embedding provider returned an invalid vector."
    )
  return value
}

async function embeddingModel(context: BuildContext) {
  const providers = await context.database.execute<{ provider: string }>(sql`
    select provider from project_model_provider
    where project_id=${context.projectId}
      and provider in (${GATEWAY_PROVIDER}, ${OPENAI_PROVIDER})
    order by case when provider=${GATEWAY_PROVIDER} then 0 else 1 end
    limit 1
  `)
  const provider = providers.rows[0]?.provider
  if (!provider) return null
  const apiKey = await getProjectProviderKey(
    context.projectId,
    provider === OPENAI_PROVIDER ? OPENAI_PROVIDER : GATEWAY_PROVIDER,
    context.database
  )
  return provider === OPENAI_PROVIDER
    ? createOpenAI({ apiKey }).embeddingModel("text-embedding-3-small")
    : createGateway({ apiKey }).embeddingModel("openai/text-embedding-3-small")
}

/**
 * Uses only project-owned credentials. An unconfigured project stays lexical;
 * a configured provider failure fails indexing so the previous revision survives.
 * Batches and heartbeats bound requests and keep long source jobs leased.
 */
export async function embedKnowledgeChunks(
  context: BuildContext,
  chunks: EmbeddingChunk[],
  options: { sourceId?: string; heartbeat?: () => Promise<void> } = {}
): Promise<number[][] | null> {
  const model = await embeddingModel(context)
  if (!model) return null
  const cache = new Map<string, number[]>()
  if (options.sourceId) {
    const previous = await context.database.execute<{
      content: string
      metadata: Record<string, unknown>
      embedding: string
    }>(sql`
      select c.content,c.metadata_json as metadata,c.embedding::text as embedding
      from build_knowledge_chunks c
      join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
      where c.project_id=${context.projectId} and c.source_id=${options.sourceId}
        and c.revision=s.active_revision and s.status <> 'deleted'
        and c.embedding_model=${KNOWLEDGE_EMBEDDING_PROFILE}
        and c.embedding is not null
    `)
    for (const row of previous.rows)
      cache.set(
        contentKey(embeddingText(row)),
        validVector(JSON.parse(row.embedding))
      )
  }
  const texts = chunks.map(embeddingText)
  const missing = [
    ...new Map(
      texts
        .filter((text) => !cache.has(contentKey(text)))
        .map((text) => [contentKey(text), text])
    ).entries(),
  ]
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    await options.heartbeat?.()
    const batch = missing.slice(offset, offset + batchSize)
    const result = await embedMany({
      model,
      values: batch.map(([, text]) => text),
      maxRetries: 1,
      maxParallelCalls: 1,
      abortSignal: AbortSignal.timeout(30_000),
    }).catch(() => {
      // Provider errors may echo requests or credentials. Only this safe
      // message is persisted in the source/job status for the user.
      throw new Error(
        "Knowledge embedding failed. Check project provider access and retry indexing."
      )
    })
    if (result.embeddings.length !== batch.length)
      throw new Error(
        "The knowledge embedding provider returned an incomplete batch."
      )
    result.embeddings.forEach((vector, index) => {
      cache.set(batch[index][0], validVector(vector))
    })
    await options.heartbeat?.()
  }
  return texts.map((text) => cache.get(contentKey(text))!)
}

/** No provider request is needed for agents whose chunks are not embedded yet. */
export async function embedKnowledgeQuery(
  context: BuildContext,
  agentId: string,
  query: string,
  signal?: AbortSignal
) {
  const indexed = await context.database.execute(sql`
    select 1 from build_knowledge_chunks c
    join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
    where c.project_id=${context.projectId} and c.agent_id=${agentId}
      and s.agent_id=${agentId} and s.status <> 'deleted'
      and c.revision=s.active_revision
      and c.embedding_model=${KNOWLEDGE_EMBEDDING_PROFILE}
      and c.embedding is not null
    limit 1
  `)
  if (!indexed.rows.length) return null
  const model = await embeddingModel(context)
  if (!model) return null
  const result = await embedMany({
    model,
    values: [query],
    maxRetries: 0,
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      : AbortSignal.timeout(5_000),
  })
  if (result.embeddings.length !== 1)
    throw new Error(
      "The knowledge embedding provider returned an incomplete query."
    )
  return validVector(result.embeddings[0])
}

/**
 * Resumable backfill for already-indexed content: no crawl and no source edits.
 * Each update is fenced to immutable chunks in the currently active revision.
 */
export async function backfillKnowledgeEmbeddings(
  context: BuildContext,
  input: { agentId: string; onProgress?: (embedded: number) => void }
) {
  const agent = await context.database.execute(sql`
    select 1 from build_agents where project_id=${context.projectId} and id=${input.agentId}
  `)
  if (!agent.rows.length)
    throw new Error("Knowledge agent not found in this project.")
  let embedded = 0
  while (true) {
    const batch = await context.database.execute<
      EmbeddingChunk & { id: string }
    >(sql`
      select c.id,c.content,c.metadata_json as metadata
      from build_knowledge_chunks c
      join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
      where c.project_id=${context.projectId} and c.agent_id=${input.agentId}
        and s.agent_id=${input.agentId} and s.status <> 'deleted'
        and c.revision=s.active_revision
        and (c.embedding is null or c.embedding_model <> ${KNOWLEDGE_EMBEDDING_PROFILE})
      order by c.source_id,c.ordinal
      limit ${batchSize}
    `)
    if (!batch.rows.length) {
      await context.database.execute(sql`
        update build_knowledge_sources s
        set status_message=nullif(trim(replace(status_message,${KEYWORD_KNOWLEDGE_NOTICE},'')),'')
        where s.project_id=${context.projectId} and s.agent_id=${input.agentId}
          and s.status='ready'
      `)
      return { embedded }
    }
    const vectors = await embedKnowledgeChunks(context, batch.rows)
    if (!vectors)
      throw new Error(
        "Configure AI Gateway or OpenAI in this project's settings to embed knowledge."
      )
    const values = sql.join(
      batch.rows.map(
        (chunk, index) =>
          sql`(${chunk.id},${JSON.stringify(vectors[index])}::public.vector)`
      ),
      sql`,`
    )
    const updated = await context.database.execute(sql`
      update build_knowledge_chunks c
      set embedding=v.embedding,embedding_model=${KNOWLEDGE_EMBEDDING_PROFILE}
      from (values ${values}) as v(id,embedding),build_knowledge_sources s
      where c.id=v.id and c.project_id=${context.projectId} and c.agent_id=${input.agentId}
        and s.project_id=c.project_id and s.id=c.source_id and s.agent_id=${input.agentId}
        and c.revision=s.active_revision and s.status <> 'deleted'
      returning c.id
    `)
    embedded += updated.rows.length
    input.onProgress?.(embedded)
  }
}
