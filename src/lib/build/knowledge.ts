import { z } from "zod"

/**
 * The public contract shared by Build UI, MCP and the ingestion worker.
 *
 * Knowledge is intentionally channel-neutral. A source belongs to one
 * managed agent, but chunks can be retrieved by any channel adapter (web,
 * Telegram, or a future connector) through the server service.
 */
export const knowledgeSourceKindSchema = z.enum([
  "text",
  "qa",
  "file",
  "website",
  "sitemap",
])
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>

export const knowledgeSourceStatusSchema = z.enum([
  "pending",
  "indexing",
  "ready",
  "error",
  "deleted",
])
export type KnowledgeSourceStatus = z.infer<typeof knowledgeSourceStatusSchema>

export const knowledgeJobKindSchema = z.enum(["index", "resync"])
export type KnowledgeJobKind = z.infer<typeof knowledgeJobKindSchema>

export const knowledgeJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])
export type KnowledgeJobStatus = z.infer<typeof knowledgeJobStatusSchema>

/** Maximum time a worker may hold an indexing lease without heartbeating. */
export const KNOWLEDGE_JOB_LEASE_SECONDS = 300

export const KNOWLEDGE_LIMITS = {
  /** Maximum source payload accepted by MCP and the service. */
  maxSourceBytes: 20 * 1024 * 1024,
  /** Maximum text retained for one source. */
  maxTextCharacters: 1_000_000,
  /** Maximum chunks generated for one source revision. */
  maxChunksPerSource: 10_000,
  /** Chunk size is deliberately character based until tokenizers are a runtime dependency. */
  chunkCharacters: 1_600,
  chunkOverlapCharacters: 200,
  maxQueryCharacters: 2_000,
  /** Maximum bounded alternate queries requested from an optional model expander. */
  maxQueryExpansions: 3,
  maxQueryExpansionCharacters: 500,
  /** Avoid constructing unbounded tsquery expressions from customer input. */
  maxQueryTerms: 32,
  maxResults: 20,
  maxCrawlPages: 5_000,
  maxCrawlConcurrency: 8,
  maxCrawlDiscoveredUrls: 5_000,
  maxCrawlBytesPerPage: 2 * 1024 * 1024,
  maxCrawlTotalBytes: 512 * 1024 * 1024,
  maxCrawlTextCharacters: 20_000_000,
  maxCrawlChunks: 20_000,
  maxCrawlPacingMs: 10_000,
  maxResyncHours: 24 * 30,
  /** Parser guardrails for compressed document formats. */
  maxArchiveEntries: 2_000,
  maxArchiveUncompressedBytes: 50 * 1024 * 1024,
  maxPdfPages: 500,
  /** Cooperative parser deadline; source and archive bounds remain the hard memory guard. */
  maxDocumentExtractionMs: 15_000,
} as const

export const qaPairSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  answer: z.string().trim().min(1).max(16_000),
})
export type KnowledgeQaPair = z.infer<typeof qaPairSchema>

export const websiteSourceConfigSchema = z.object({
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(KNOWLEDGE_LIMITS.maxCrawlPages)
    .default(KNOWLEDGE_LIMITS.maxCrawlPages),
  pacingMs: z
    .number()
    .int()
    .min(0)
    .max(KNOWLEDGE_LIMITS.maxCrawlPacingMs)
    .default(250),
  /** A simple substring or glob-like pattern is safer than evaluating user regexes. */
  excludePattern: z.string().trim().max(200).optional(),
  followSitemap: z.boolean().default(true),
  autoResyncHours: z
    .number()
    .int()
    .min(0)
    .max(KNOWLEDGE_LIMITS.maxResyncHours)
    .default(0),
})
export type WebsiteSourceConfig = z.infer<typeof websiteSourceConfigSchema>

export const knowledgeSourceBaseSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  agentId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  kind: knowledgeSourceKindSchema,
})

export const createKnowledgeSourceSchema = z.discriminatedUnion("kind", [
  knowledgeSourceBaseSchema.extend({
    kind: z.literal("text"),
    text: z.string().max(KNOWLEDGE_LIMITS.maxTextCharacters),
  }),
  knowledgeSourceBaseSchema.extend({
    kind: z.literal("qa"),
    pairs: z.array(qaPairSchema).min(1).max(10_000),
  }),
  knowledgeSourceBaseSchema.extend({
    kind: z.literal("file"),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(160).optional(),
    /** Base64 keeps the MCP/API contract JSON-safe. UI callers may use bytes via the service helper. */
    contentBase64: z
      .string()
      .min(1)
      .max(Math.ceil((KNOWLEDGE_LIMITS.maxSourceBytes * 4) / 3) + 8),
  }),
  knowledgeSourceBaseSchema.extend({
    kind: z.literal("website"),
    url: z.string().trim().url(),
    config: websiteSourceConfigSchema.optional(),
  }),
  knowledgeSourceBaseSchema.extend({
    kind: z.literal("sitemap"),
    url: z.string().trim().url(),
    config: websiteSourceConfigSchema.optional(),
  }),
])
export type CreateKnowledgeSourceInput = z.input<
  typeof createKnowledgeSourceSchema
>

export const updateKnowledgeSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200).optional(),
  text: z.string().max(KNOWLEDGE_LIMITS.maxTextCharacters).optional(),
  pairs: z.array(qaPairSchema).min(1).max(10_000).optional(),
  url: z.string().trim().url().optional(),
  config: z
    .object({
      maxPages: websiteSourceConfigSchema.shape.maxPages
        .removeDefault()
        .optional(),
      pacingMs: websiteSourceConfigSchema.shape.pacingMs
        .removeDefault()
        .optional(),
      excludePattern: websiteSourceConfigSchema.shape.excludePattern,
      followSitemap: websiteSourceConfigSchema.shape.followSitemap
        .removeDefault()
        .optional(),
      autoResyncHours: websiteSourceConfigSchema.shape.autoResyncHours
        .removeDefault()
        .optional(),
    })
    .optional(),
  expectedRevision: z.number().int().positive().optional(),
})
export type UpdateKnowledgeSourceInput = z.infer<
  typeof updateKnowledgeSourceSchema
>

export type KnowledgeSource = {
  id: string
  projectId: string
  agentId: string
  name: string
  kind: KnowledgeSourceKind
  status: KnowledgeSourceStatus
  statusMessage: string | null
  uri: string | null
  mimeType: string | null
  fileName: string | null
  revision: number
  activeRevision: number
  lastIndexedAt: string | null
  nextResyncAt: string | null
  createdAt: string
  updatedAt: string
  chunkCount?: number
}

export type KnowledgeSourceDetail = KnowledgeSource & {
  text: string
  pairs: KnowledgeQaPair[]
  config?: WebsiteSourceConfig
}

export type KnowledgePage = {
  url: string
  title: string | null
  fetchedAt: string | null
  contentType: string | null
}

export type KnowledgePageList = {
  items: KnowledgePage[]
  total: number
  filteredTotal: number
  revision: number
}

export type KnowledgePageDetail = KnowledgePage & {
  markdown: string
  revision: number
  contentOrigin: "crawl" | "chunks"
}

export type KnowledgeChunk = {
  id: string
  sourceId: string
  agentId: string
  ordinal: number
  content: string
  metadata: Record<string, unknown>
  revision: number
}

export type KnowledgeSearchResult = {
  chunkId: string
  sourceId: string
  agentId: string
  sourceName: string
  sourceKind: KnowledgeSourceKind
  content: string
  metadata: Record<string, unknown>
  score: number
  revision: number
}

/**
 * Optional runtime hook for recall improvements. The hook receives only the
 * bounded customer query and may return alternate search queries; every result
 * still comes from the indexed chunks and keeps its original provenance.
 */
export type KnowledgeQueryExpander = (input: {
  query: string
  agentId: string
  maxQueries: number
  maxCharacters: number
}) => Promise<readonly string[]>

export type KnowledgeJob = {
  id: string
  sourceId: string
  kind: KnowledgeJobKind
  status: KnowledgeJobStatus
  attempts: number
  error: string | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  leaseExpiresAt: string | null
  heartbeatAt: string | null
}

export function normalizeKnowledgeText(text: string) {
  return text
    .replaceAll("\u0000", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
}

/**
 * Split on paragraph/sentence boundaries while retaining a small overlap for
 * retrieval continuity. The output is bounded before it reaches the database.
 */
export function chunkKnowledgeText(
  input: string,
  options: {
    maxCharacters?: number
    overlapCharacters?: number
    maxChunks?: number
  } = {}
) {
  const text = normalizeKnowledgeText(input)
  const maxCharacters =
    options.maxCharacters ?? KNOWLEDGE_LIMITS.chunkCharacters
  const overlapCharacters = Math.min(
    options.overlapCharacters ?? KNOWLEDGE_LIMITS.chunkOverlapCharacters,
    Math.floor(maxCharacters / 2)
  )
  const maxChunks = options.maxChunks ?? KNOWLEDGE_LIMITS.maxChunksPerSource
  if (!text) return [] as string[]

  const chunks: string[] = []
  let offset = 0
  while (offset < text.length && chunks.length < maxChunks) {
    const end = Math.min(text.length, offset + maxCharacters)
    let boundary = end
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n\n", end)
      const sentence = Math.max(
        text.lastIndexOf(". ", end),
        text.lastIndexOf("? ", end),
        text.lastIndexOf("! ", end)
      )
      const candidate = Math.max(paragraph, sentence)
      if (candidate > offset + Math.floor(maxCharacters * 0.55))
        boundary = candidate + (candidate === paragraph ? 2 : 2)
    }
    const chunk = text.slice(offset, boundary).trim()
    if (chunk) chunks.push(chunk)
    if (boundary >= text.length) break
    offset = Math.max(boundary - overlapCharacters, offset + 1)
  }
  return chunks
}

export function parseKnowledgeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>
  if (typeof value !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
