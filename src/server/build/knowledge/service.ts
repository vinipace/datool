import { enabledBuildProject } from "../access"
import { createHash, randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"

import { sql, type SQL } from "drizzle-orm"
import type { TracerDatabase } from "@/src/server/tracer/db"
import {
  createKnowledgeSourceSchema,
  KNOWLEDGE_JOB_LEASE_SECONDS,
  KNOWLEDGE_LIMITS,
  chunkKnowledgeText,
  knowledgeJobKindSchema,
  knowledgeJobStatusSchema,
  knowledgeSourceKindSchema,
  knowledgeSourceStatusSchema,
  normalizeKnowledgeText,
  parseKnowledgeJson,
  qaPairSchema,
  updateKnowledgeSourceSchema,
  websiteSourceConfigSchema,
  type CreateKnowledgeSourceInput,
  type KnowledgeJob,
  type KnowledgeQueryExpander,
  type KnowledgeSearchResult,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type UpdateKnowledgeSourceInput,
  type WebsiteSourceConfig,
} from "@/src/lib/build/knowledge"
import type { BuildContext } from "@/src/server/build/context"
import {
  crawlKnowledgeSource,
  assertPublicUrl,
  type CrawledPage,
  type CrawlProgress,
  type CrawlCheckpoint,
} from "./crawler"
import {
  extractDocumentText,
  KnowledgeExtractionError,
  qaPairsToText,
} from "./extract"
import {
  embedKnowledgeChunks,
  embedKnowledgeQuery,
  KEYWORD_KNOWLEDGE_NOTICE,
  KNOWLEDGE_EMBEDDING_PROFILE,
} from "./embeddings"
import { rankKnowledgeCandidates } from "./ranking"

/**
 * BuildContext is intentionally structural here so this module can be used by
 * MCP, server actions and workers without coupling the knowledge layer to an
 * HTTP transport. The foundation context has this exact database/project
 * shape; its additional organization and actor fields are optional here.
 */
export type KnowledgeBuildContext = BuildContext

export class KnowledgeServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "VALIDATION"
      | "NOT_FOUND"
      | "CONFLICT"
      | "EXTRACTION"
      | "CRAWL"
      | "JOB" = "VALIDATION",
    readonly status = code === "NOT_FOUND"
      ? 404
      : code === "CONFLICT"
        ? 409
        : 400
  ) {
    super(message)
    this.name = "KnowledgeServiceError"
  }
}

type QueryResult<Row> = { rows: Row[] }
type SourceRow = {
  id: string
  projectId: string
  agentId: string
  kind: string
  name: string
  uri: string | null
  mimeType: string | null
  fileName: string | null
  status: string
  statusMessage: string | null
  revision: number
  activeRevision: number
  lastIndexedAt: string | null
  nextResyncAt: string | null
  createdAt: string
  updatedAt: string
  contentText: string | null
  contentJson: unknown
  configJson: unknown
  contentHash: string | null
  chunkCount?: string | number
}

type JobRow = {
  id: string
  sourceId: string
  kind: string
  status: string
  attempts: number
  error: string | null
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  leaseExpiresAt: string | null
  heartbeatAt: string | null
}

function assertContext(ctx: KnowledgeBuildContext) {
  if (!ctx.projectId?.trim())
    throw new KnowledgeServiceError("A project scope is required.")
  if (!ctx.database)
    throw new KnowledgeServiceError("A database scope is required.")
}

async function query<Row>(
  database: TracerDatabase,
  statement: SQL
): Promise<Row[]> {
  const result = (await database.execute(
    statement
  )) as unknown as QueryResult<Row>
  return result.rows ?? []
}

function parseJson(value: unknown): Record<string, unknown> {
  return parseKnowledgeJson(value)
}

function sourceFromRow(row: SourceRow): KnowledgeSource {
  const kind = knowledgeSourceKindSchema.safeParse(row.kind)
  const status = knowledgeSourceStatusSchema.safeParse(row.status)
  if (!kind.success || !status.success)
    throw new KnowledgeServiceError(
      "Stored knowledge source state is invalid.",
      "JOB",
      500
    )
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    kind: kind.data,
    status: status.data,
    statusMessage: row.statusMessage,
    uri: row.uri,
    mimeType: row.mimeType,
    fileName: row.fileName,
    revision: Number(row.revision),
    activeRevision: Number(row.activeRevision),
    lastIndexedAt: row.lastIndexedAt,
    nextResyncAt: row.nextResyncAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    chunkCount:
      row.chunkCount === undefined ? undefined : Number(row.chunkCount),
  }
}

function jobFromRow(row: JobRow): KnowledgeJob {
  const kind = knowledgeJobKindSchema.safeParse(row.kind)
  const status = knowledgeJobStatusSchema.safeParse(row.status)
  if (!kind.success || !status.success)
    throw new KnowledgeServiceError(
      "Stored knowledge job state is invalid.",
      "JOB",
      500
    )
  return {
    id: row.id,
    sourceId: row.sourceId,
    kind: kind.data,
    status: status.data,
    attempts: Number(row.attempts),
    error: row.error,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    heartbeatAt: row.heartbeatAt,
  }
}

async function getSourceRow(
  ctx: KnowledgeBuildContext,
  sourceId: string,
  options: { forUpdate?: boolean } = {}
) {
  const lock = options.forUpdate ? sql` for update` : sql``
  const rows = await query<SourceRow>(
    ctx.database,
    sql`select
      id,
      project_id as "projectId",
      agent_id as "agentId",
      kind,
      name,
      uri,
      mime_type as "mimeType",
      file_name as "fileName",
      status,
      status_message as "statusMessage",
      revision,
      active_revision as "activeRevision",
      last_indexed_at as "lastIndexedAt",
      next_resync_at as "nextResyncAt",
      created_at as "createdAt",
      updated_at as "updatedAt",
      content_text as "contentText",
      content_json as "contentJson",
      config_json as "configJson",
      content_hash as "contentHash",
      (select count(*) from build_knowledge_chunks c
        where c.project_id=build_knowledge_sources.project_id
          and c.source_id=build_knowledge_sources.id
          and c.revision=build_knowledge_sources.active_revision) as "chunkCount"
      from build_knowledge_sources
      where project_id=${ctx.projectId} and id=${sourceId}${lock}`
  )
  const row = rows[0]
  if (!row)
    throw new KnowledgeServiceError(
      "Knowledge source not found.",
      "NOT_FOUND",
      404
    )
  return row
}

function safeBase64Bytes(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1)
    throw new KnowledgeServiceError("The uploaded file is not valid base64.")
  const bytes = Buffer.from(value, "base64")
  if (!bytes.byteLength || bytes.byteLength > KNOWLEDGE_LIMITS.maxSourceBytes)
    throw new KnowledgeServiceError(
      `The uploaded file exceeds the ${KNOWLEDGE_LIMITS.maxSourceBytes} byte limit.`
    )
  return new Uint8Array(bytes)
}

function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function sourceConfig(input: { config?: Partial<WebsiteSourceConfig> }) {
  return websiteSourceConfigSchema.parse(input.config ?? {})
}

async function sourceContent(input: CreateKnowledgeSourceInput): Promise<{
  text: string | null
  json: Record<string, unknown>
  uri?: string
  mimeType?: string
  fileName?: string
}> {
  if (input.kind === "text")
    return { text: normalizeKnowledgeText(input.text), json: {} }
  if (input.kind === "qa")
    return { text: qaPairsToText(input.pairs), json: { pairs: input.pairs } }
  if (input.kind === "file") {
    try {
      const bytes = safeBase64Bytes(input.contentBase64)
      const extracted = await extractDocumentText({
        fileName: input.fileName,
        mimeType: input.mimeType,
        bytes,
      })
      return {
        text: normalizeKnowledgeText(extracted.text),
        json: {
          fileName: input.fileName,
          mimeType: input.mimeType ?? extracted.mimeType,
        },
        mimeType: input.mimeType ?? extracted.mimeType,
        fileName: input.fileName,
      }
    } catch (error) {
      if (error instanceof KnowledgeExtractionError)
        throw new KnowledgeServiceError(error.message, "EXTRACTION")
      throw error
    }
  }
  return {
    text: null,
    json: { config: sourceConfig(input) },
    uri: input.url,
  }
}

export async function previewKnowledgeSourceInput(
  input: CreateKnowledgeSourceInput
) {
  const parsed = createKnowledgeSourceSchema.safeParse(input)
  if (!parsed.success)
    throw new KnowledgeServiceError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" ")
    )
  const content = await sourceContent(parsed.data)
  return {
    kind: parsed.data.kind,
    name: parsed.data.name,
    text: content.text,
    metadata: content.json,
    uri: content.uri ?? null,
    mimeType: content.mimeType ?? null,
    fileName: content.fileName ?? null,
  }
}

export async function getKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string }
): Promise<KnowledgeSourceDetail> {
  assertContext(ctx)
  if (!input.sourceId?.trim())
    throw new KnowledgeServiceError("sourceId is required.")
  const row = await getSourceRow(ctx, input.sourceId)
  return {
    ...sourceFromRow(row),
    text: row.contentText ?? "",
    ...(row.kind === "website" || row.kind === "sitemap"
      ? { config: websiteSourceConfigSchema.parse(parseJson(row.configJson)) }
      : {}),
    pairs:
      row.kind === "qa"
        ? qaPairSchema.array().parse(parseJson(row.contentJson).pairs)
        : [],
  }
}

export async function listKnowledgeSources(
  ctx: KnowledgeBuildContext,
  input: { agentId: string; limit?: number; cursor?: string }
) {
  assertContext(ctx)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const rows = await query<SourceRow>(
    ctx.database,
    sql`select
      s.id,
      s.project_id as "projectId",
      s.agent_id as "agentId",
      s.kind,
      s.name,
      s.uri,
      s.mime_type as "mimeType",
      s.file_name as "fileName",
      s.status,
      s.status_message as "statusMessage",
      s.revision,
      s.active_revision as "activeRevision",
      s.last_indexed_at as "lastIndexedAt",
      s.next_resync_at as "nextResyncAt",
      s.created_at as "createdAt",
      s.updated_at as "updatedAt",
      s.content_hash as "contentHash",
      (select count(*) from build_knowledge_chunks c where c.project_id=s.project_id and c.source_id=s.id and c.revision=s.active_revision) as "chunkCount"
      from build_knowledge_sources s
      where s.project_id=${ctx.projectId} and s.agent_id=${input.agentId}
        and s.status <> 'deleted'
        ${input.cursor ? sql`and (s.updated_at,s.id) < ((select updated_at from build_knowledge_sources where project_id=${ctx.projectId} and id=${input.cursor}),${input.cursor})` : sql``}
      order by s.updated_at desc, s.id desc limit ${limit}`
  )
  return rows.map(sourceFromRow)
}

export async function createKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: CreateKnowledgeSourceInput
) {
  assertContext(ctx)
  const parsed = createKnowledgeSourceSchema.safeParse(input)
  if (!parsed.success)
    throw new KnowledgeServiceError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" ")
    )
  const content = await sourceContent(parsed.data)
  if (
    content.text !== null &&
    content.text.length > KNOWLEDGE_LIMITS.maxTextCharacters
  )
    throw new KnowledgeServiceError(
      `The source exceeds the ${KNOWLEDGE_LIMITS.maxTextCharacters} character limit.`
    )
  if (parsed.data.kind === "website" || parsed.data.kind === "sitemap") {
    try {
      await assertPublicUrl(parsed.data.url)
    } catch (error) {
      throw new KnowledgeServiceError(
        error instanceof Error ? error.message : "The source URL is not safe.",
        "CRAWL"
      )
    }
  }
  const id = parsed.data.id ?? `ks_${randomUUID().replaceAll("-", "")}`
  const now = new Date().toISOString()
  const config =
    parsed.data.kind === "website" || parsed.data.kind === "sitemap"
      ? sourceConfig(parsed.data)
      : {}
  try {
    await ctx.database.transaction(async (transaction) => {
      const tx = transaction as unknown as TracerDatabase
      await tx.execute(sql`insert into build_knowledge_sources
        (id,project_id,agent_id,kind,name,uri,mime_type,file_name,content_text,content_json,config_json,status,revision,active_revision,content_hash,created_at,updated_at)
        values (${id},${ctx.projectId},${parsed.data.agentId},${parsed.data.kind},${parsed.data.name},${content.uri ?? null},${content.mimeType ?? null},${content.fileName ?? null},${content.text},${JSON.stringify(content.json)}::jsonb,${JSON.stringify(config)}::jsonb,'pending',1,0,${content.text ? contentHash(content.text) : null},${now},${now})`)
      await tx.execute(sql`insert into build_knowledge_jobs (id,project_id,source_id,kind,status,attempts,queued_at)
        values (${`kj_${randomUUID().replaceAll("-", "")}`},${ctx.projectId},${id},'index','queued',0,${now})`)
    })
  } catch (error) {
    const dbError = error as { code?: string; message?: string }
    if (dbError.code === "23505")
      throw new KnowledgeServiceError(
        "A knowledge source with this id already exists.",
        "CONFLICT",
        409
      )
    throw error
  }
  return getKnowledgeSource(ctx, { sourceId: id })
}

export async function updateKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: UpdateKnowledgeSourceInput
) {
  assertContext(ctx)
  const parsed = updateKnowledgeSourceSchema.safeParse(input)
  if (!parsed.success)
    throw new KnowledgeServiceError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" ")
    )
  const existing = await getSourceRow(ctx, parsed.data.sourceId)
  if (existing.status === "deleted")
    throw new KnowledgeServiceError(
      "Knowledge source is deleted.",
      "NOT_FOUND",
      404
    )
  if (
    parsed.data.expectedRevision !== undefined &&
    parsed.data.expectedRevision !== Number(existing.revision)
  )
    throw new KnowledgeServiceError(
      "The knowledge source changed. Reload before editing.",
      "CONFLICT",
      409
    )
  if (
    existing.kind === "file" &&
    (parsed.data.text !== undefined || parsed.data.pairs !== undefined)
  )
    throw new KnowledgeServiceError(
      "Uploaded files are immutable; upload a replacement file source."
    )
  if (parsed.data.pairs !== undefined && existing.kind !== "qa")
    throw new KnowledgeServiceError("Q&A pairs can only update a Q&A source.")
  if (parsed.data.text !== undefined && existing.kind !== "text")
    throw new KnowledgeServiceError(
      "Text content can only update a text source."
    )
  if (
    parsed.data.url !== undefined &&
    existing.kind !== "website" &&
    existing.kind !== "sitemap"
  )
    throw new KnowledgeServiceError("Only website sources have a URL.")
  if (parsed.data.url !== undefined) {
    try {
      await assertPublicUrl(parsed.data.url)
    } catch (error) {
      throw new KnowledgeServiceError(
        error instanceof Error ? error.message : "The source URL is not safe.",
        "CRAWL"
      )
    }
  }
  const text =
    parsed.data.text !== undefined
      ? normalizeKnowledgeText(parsed.data.text)
      : parsed.data.pairs
        ? qaPairsToText(parsed.data.pairs)
        : existing.contentText
  const contentJson = parsed.data.pairs
    ? { pairs: parsed.data.pairs }
    : parseJson(existing.contentJson)
  const currentConfig = parseJson(existing.configJson)
  const config = parsed.data.config
    ? websiteSourceConfigSchema.parse({
        ...currentConfig,
        ...parsed.data.config,
      })
    : currentConfig
  const now = new Date().toISOString()
  const extendCrawl =
    (existing.kind === "website" || existing.kind === "sitemap") &&
    (parsed.data.url === undefined ||
      new URL(parsed.data.url).href === new URL(existing.uri!).href) &&
    Number(config.maxPages) > Number(currentConfig.maxPages) &&
    config.excludePattern === currentConfig.excludePattern &&
    config.followSitemap === currentConfig.followSitemap
  const nextJobId = `kj_${randomUUID().replaceAll("-", "")}`
  await ctx.database.transaction(async (transaction) => {
    const tx = transaction as unknown as TracerDatabase
    // A running index may have captured the previous source revision. Mark it
    // cancelled before changing the source so the partial unique queue index
    // can accept the replacement job. The worker's revision check then drops
    // any stale result without touching the newly edited source.
    await tx.execute(sql`update build_knowledge_jobs set
      status='cancelled', finished_at=${now}, heartbeat_at=${now},
      lease_token=null, lease_expires_at=null,
      error='Superseded by a source update.'
      where project_id=${ctx.projectId} and source_id=${parsed.data.sourceId}
        and status in ('queued','running')`)
    const updateResult = await query<{ revision: number }>(
      tx,
      sql`update build_knowledge_sources set
        name=coalesce(${parsed.data.name ?? null},name),
        uri=coalesce(${parsed.data.url ?? null},uri),
        content_text=${text},
        content_json=${JSON.stringify(contentJson)}::jsonb,
        config_json=${JSON.stringify(config)}::jsonb,
        status='pending', status_message=null,
        revision=revision+1, updated_at=${now},
        content_hash=${text ? contentHash(text) : null}
        where project_id=${ctx.projectId} and id=${parsed.data.sourceId}
          and revision=${existing.revision}
        returning revision`
    )
    if (!updateResult.length)
      throw new KnowledgeServiceError(
        "The knowledge source changed. Reload before editing.",
        "CONFLICT",
        409
      )
    await tx.execute(sql`insert into build_knowledge_jobs (id,project_id,source_id,kind,status,attempts,queued_at)
      values (${nextJobId},${ctx.projectId},${parsed.data.sourceId},'index','queued',0,${now})
      on conflict (project_id,source_id) where status in ('queued','running') do nothing`)
    if (extendCrawl)
      await tx.execute(sql`
      insert into build_knowledge_crawl_pages(project_id,job_id,source_revision,url,page_json)
      select p.project_id,${nextJobId},${updateResult[0].revision},p.url,p.page_json
      from build_knowledge_crawl_pages p
      where p.project_id=${ctx.projectId} and p.source_revision=${existing.revision}
        and p.job_id=(select j.id from build_knowledge_jobs j
          where j.project_id=${ctx.projectId} and j.source_id=${parsed.data.sourceId} and j.id<>${nextJobId}
            and exists(select 1 from build_knowledge_crawl_pages saved where saved.project_id=j.project_id and saved.job_id=j.id)
          order by j.queued_at desc limit 1)
      on conflict do nothing
    `)
    await tx.execute(sql`delete from build_knowledge_crawl_pages p using build_knowledge_jobs j
      where p.project_id=${ctx.projectId} and p.job_id=j.id and j.source_id=${parsed.data.sourceId} and p.job_id<>${nextJobId}`)
  })
  return getKnowledgeSource(ctx, { sourceId: parsed.data.sourceId })
}

export async function deleteKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string }
) {
  assertContext(ctx)
  const result = await query<{ id: string }>(
    ctx.database,
    sql`delete from build_knowledge_sources where project_id=${ctx.projectId} and id=${input.sourceId} returning id`
  )
  if (!result.length)
    throw new KnowledgeServiceError(
      "Knowledge source not found.",
      "NOT_FOUND",
      404
    )
  return { id: input.sourceId, deleted: true }
}

export async function enqueueKnowledgeIndex(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string; kind?: "index" | "resync" }
) {
  assertContext(ctx)
  const source = await getSourceRow(ctx, input.sourceId)
  if (source.status === "deleted")
    throw new KnowledgeServiceError(
      "Knowledge source is deleted.",
      "NOT_FOUND",
      404
    )
  const kind = input.kind ?? "index"
  const now = new Date().toISOString()
  const rows = await query<JobRow>(
    ctx.database,
    sql`insert into build_knowledge_jobs (id,project_id,source_id,kind,status,attempts,queued_at)
      values (${`kj_${randomUUID().replaceAll("-", "")}`},${ctx.projectId},${input.sourceId},${kind},'queued',0,${now})
      on conflict (project_id,source_id) where status in ('queued','running') do nothing
      returning id,source_id as "sourceId",kind,status,attempts,error,queued_at as "queuedAt",started_at as "startedAt",finished_at as "finishedAt",lease_expires_at as "leaseExpiresAt",heartbeat_at as "heartbeatAt"`
  )
  if (rows[0]) return jobFromRow(rows[0])
  const existing = await query<JobRow>(
    ctx.database,
    sql`select id,source_id as "sourceId",kind,status,attempts,error,queued_at as "queuedAt",started_at as "startedAt",finished_at as "finishedAt",lease_expires_at as "leaseExpiresAt",heartbeat_at as "heartbeatAt" from build_knowledge_jobs where project_id=${ctx.projectId} and source_id=${input.sourceId} and status in ('queued','running') order by queued_at desc limit 1`
  )
  if (!existing[0])
    throw new KnowledgeServiceError(
      "Could not enqueue the knowledge job.",
      "JOB",
      500
    )
  return jobFromRow(existing[0])
}

/**
 * Extend an active worker lease. The token is a fencing key: an owner that
 * was reclaimed, superseded by an edit, or deleted can no longer heartbeat or
 * publish even if its process eventually resumes.
 */
export async function heartbeatKnowledgeJob(
  ctx: KnowledgeBuildContext,
  input: { jobId: string; leaseToken: string }
) {
  assertContext(ctx)
  if (!input.jobId?.trim() || !input.leaseToken?.trim())
    throw new KnowledgeServiceError(
      "jobId and leaseToken are required for a knowledge heartbeat."
    )
  const rows = await query<JobRow>(
    ctx.database,
    sql`update build_knowledge_jobs set
      heartbeat_at=now(),
      lease_expires_at=now()+(${KNOWLEDGE_JOB_LEASE_SECONDS} * interval '1 second')
      where project_id=${ctx.projectId} and id=${input.jobId}
        and status='running' and lease_token=${input.leaseToken}
        and (lease_expires_at is null or lease_expires_at > now())
      returning id,source_id as "sourceId",kind,status,attempts,error,
        queued_at as "queuedAt",started_at as "startedAt",finished_at as "finishedAt",
        lease_expires_at as "leaseExpiresAt",heartbeat_at as "heartbeatAt"`
  )
  if (!rows[0])
    throw new KnowledgeServiceError(
      "The knowledge job lease is no longer active.",
      "CONFLICT",
      409
    )
  return jobFromRow(rows[0])
}

async function sourcePayload(
  row: SourceRow,
  options: {
    heartbeat?: (progress?: CrawlProgress) => Promise<void>
    checkpoints?: CrawlCheckpoint[]
    onPage?: (checkpoint: CrawlCheckpoint) => Promise<void>
  } = {}
) {
  if (row.kind === "text" || row.kind === "qa" || row.kind === "file")
    return {
      text: normalizeKnowledgeText(row.contentText ?? ""),
      pages: [] as CrawledPage[],
      metadata: parseJson(row.contentJson),
    }
  if (!row.uri)
    throw new KnowledgeServiceError("The website source has no URL.", "CRAWL")
  const config = websiteSourceConfigSchema.parse(parseJson(row.configJson))
  try {
    const { pages, summary } = await crawlKnowledgeSource({
      kind: row.kind as "website" | "sitemap",
      url: row.uri,
      config,
      onProgress: options.heartbeat,
      checkpoints: options.checkpoints,
      onPage: options.onPage,
    })
    return {
      text: normalizeKnowledgeText(
        pages
          .map((page) => `${page.title ? `# ${page.title}\n` : ""}${page.text}`)
          .join("\n\n")
      ),
      pages,
      metadata: {
        config,
        crawl: summary,
        pages: pages.map(({ url, title, fetchedAt, contentType }) => ({
          url,
          title,
          fetchedAt,
          contentType,
        })),
      },
    }
  } catch (error) {
    throw new KnowledgeServiceError(
      error instanceof Error ? error.message : "The website crawl failed.",
      "CRAWL"
    )
  }
}

export async function runKnowledgeJob(
  ctx: KnowledgeBuildContext,
  input: { jobId: string }
) {
  assertContext(ctx)
  const leaseToken = randomUUID()
  const claimed = await query<{
    jobId: string
    sourceId: string
    sourceRevision: number
    leaseToken: string
  }>(
    ctx.database,
    sql`with claimed as (
      update build_knowledge_jobs j set
        status='running',
        attempts=j.attempts+1,
        started_at=now(),
        heartbeat_at=now(),
        lease_expires_at=now()+(${KNOWLEDGE_JOB_LEASE_SECONDS} * interval '1 second'),
        lease_token=${leaseToken},
        error=null
      from build_knowledge_sources s
      where j.id=${input.jobId} and j.project_id=${ctx.projectId} and j.source_id=s.id and s.project_id=j.project_id
        and s.status <> 'deleted'
        and (
          j.status='queued'
          or (j.status='running' and (j.lease_expires_at is null or j.lease_expires_at <= now()))
        )
      returning j.id as "jobId", j.source_id as "sourceId", s.revision as "sourceRevision", j.lease_token as "leaseToken"
    ) select * from claimed`
  )
  if (!claimed[0]) {
    const existing = await query<JobRow>(
      ctx.database,
      sql`select id,source_id as "sourceId",kind,status,attempts,error,queued_at as "queuedAt",started_at as "startedAt",finished_at as "finishedAt",lease_expires_at as "leaseExpiresAt",heartbeat_at as "heartbeatAt" from build_knowledge_jobs where project_id=${ctx.projectId} and id=${input.jobId}`
    )
    if (!existing[0])
      throw new KnowledgeServiceError(
        "Knowledge job not found.",
        "NOT_FOUND",
        404
      )
    return jobFromRow(existing[0])
  }
  const sourceId = claimed[0].sourceId
  try {
    const heartbeat = async (progress?: CrawlProgress | string) => {
      await heartbeatKnowledgeJob(ctx, {
        jobId: claimed[0].jobId,
        leaseToken: claimed[0].leaseToken,
      })
      if (progress) {
        const message =
          typeof progress === "string"
            ? progress
            : `Crawling: ${progress.indexedPages} pages read, ${progress.discoveredPages} discovered${progress.failedPages ? `, ${progress.failedPages} failed` : ""}.`
        await ctx.database.execute(sql`
          update build_knowledge_sources set status_message=${message}
          where project_id=${ctx.projectId} and id=${sourceId}
            and revision=${claimed[0].sourceRevision} and status='indexing'
            and exists (select 1 from build_knowledge_jobs where id=${claimed[0].jobId}
              and status='running' and lease_token=${claimed[0].leaseToken}
              and lease_expires_at > now())
        `)
      }
    }
    await heartbeat()
    await ctx.database.execute(
      sql`update build_knowledge_sources set status='indexing',status_message=null,updated_at=now() where project_id=${ctx.projectId} and id=${sourceId} and revision=${claimed[0].sourceRevision} and status <> 'deleted'`
    )
    const source = await getSourceRow(ctx, sourceId)
    if (Number(source.revision) !== Number(claimed[0].sourceRevision))
      throw new KnowledgeServiceError(
        "The source changed while this job was starting; a newer job will index it.",
        "CONFLICT",
        409
      )
    const saved = await query<{ page: CrawlCheckpoint }>(
      ctx.database,
      sql`
      select page_json as page from build_knowledge_crawl_pages
      where project_id=${ctx.projectId} and job_id=${input.jobId}
        and source_revision=${claimed[0].sourceRevision}
      order by created_at,url
    `
    )
    const payload = await sourcePayload(source, {
      heartbeat,
      checkpoints: saved.map((row) => row.page),
      onPage: async (checkpoint) => {
        const persisted = await ctx.database.execute(sql`
          with owner as (
            select id from build_knowledge_jobs
            where project_id=${ctx.projectId} and id=${input.jobId}
              and status='running' and lease_token=${claimed[0].leaseToken}
              and lease_expires_at > now()
            for update
          )
          insert into build_knowledge_crawl_pages(project_id,job_id,source_revision,url,page_json)
          select ${ctx.projectId},id,${claimed[0].sourceRevision},${checkpoint.requestUrl},${JSON.stringify(checkpoint)}::jsonb from owner
          on conflict(project_id,job_id,url) do update set page_json=excluded.page_json
          returning url
        `)
        if (!persisted.rows.length)
          throw new KnowledgeServiceError(
            "The crawl lease was lost; saved pages will be resumed by the next worker.",
            "CONFLICT",
            409
          )
      },
    })
    await heartbeat()
    if (!payload.text)
      throw new KnowledgeServiceError(
        "The source has no extractable text.",
        "EXTRACTION"
      )
    const website = source.kind === "website" || source.kind === "sitemap"
    const textLimit = website
      ? KNOWLEDGE_LIMITS.maxCrawlTextCharacters
      : KNOWLEDGE_LIMITS.maxTextCharacters
    const chunkLimit = website
      ? KNOWLEDGE_LIMITS.maxCrawlChunks
      : KNOWLEDGE_LIMITS.maxChunksPerSource
    if (payload.text.length > textLimit)
      throw new KnowledgeServiceError(
        `The source exceeds the ${textLimit} character limit.`,
        "EXTRACTION"
      )
    const chunks: Array<{
      content: string
      metadata: Record<string, unknown>
    }> = []
    if (payload.pages.length) {
      for (const page of payload.pages) {
        const pageChunks = chunkKnowledgeText(page.text)
        for (const content of pageChunks)
          chunks.push({
            content,
            metadata: {
              url: page.url,
              title: page.title ?? null,
              fetchedAt: page.fetchedAt,
              contentType: page.contentType,
            },
          })
      }
    } else {
      const pageChunks = chunkKnowledgeText(payload.text)
      for (const content of pageChunks) chunks.push({ content, metadata: {} })
    }
    if (!chunks.length)
      throw new KnowledgeServiceError(
        "The source has no indexable chunks.",
        "EXTRACTION"
      )
    if (chunks.length > chunkLimit)
      throw new KnowledgeServiceError(
        `The source exceeds the ${chunkLimit} chunk limit.`
      )
    await heartbeat(
      website
        ? `Indexing ${payload.pages.length} pages. Preparing content for your agent.`
        : "Indexing content for your agent."
    )
    const embeddings = await embedKnowledgeChunks(ctx, chunks, {
      sourceId,
      heartbeat,
    })
    await heartbeat("Saving index. Almost ready.")
    // Source revisions fence edits. Index revisions are separate so a resync
    // can stage a fresh chunk set while the previous active revision remains
    // queryable until the replacement commits.
    const sourceRevision = Number(source.revision)
    const indexRevision = Math.max(
      sourceRevision,
      Number(source.activeRevision) + 1
    )
    const now = new Date().toISOString()
    const crawl =
      "crawl" in payload.metadata
        ? (payload.metadata.crawl as {
            indexedPages: number
            failedPages: number
            truncated: boolean
          })
        : null
    const crawlMessage = crawl
      ? `${crawl.indexedPages} pages indexed.${crawl.failedPages ? ` ${crawl.failedPages} pages could not be fetched.` : ""}${crawl.truncated ? " Crawl limit reached; some pages were not indexed." : ""}`
      : ""
    const statusMessage = [
      crawlMessage,
      embeddings ? "" : KEYWORD_KNOWLEDGE_NOTICE,
    ].filter(Boolean).join(" ") || null
    const nextResync = (() => {
      const config = parseJson(source.configJson)
      const hours =
        typeof config.autoResyncHours === "number" ? config.autoResyncHours : 0
      return hours > 0
        ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
        : null
    })()
    await ctx.database.transaction(async (transaction) => {
      const tx = transaction as unknown as TracerDatabase
      const owner = await query<{ id: string }>(
        tx,
        sql`select id from build_knowledge_jobs
          where project_id=${ctx.projectId} and id=${input.jobId}
            and status='running' and lease_token=${claimed[0].leaseToken}
            and (lease_expires_at is null or lease_expires_at > now())
          for update`
      )
      if (!owner[0])
        throw new KnowledgeServiceError(
          "The knowledge job lease is no longer active; its result was discarded.",
          "CONFLICT",
          409
        )
      const current = await query<{ revision: number }>(
        tx,
        sql`select revision from build_knowledge_sources where project_id=${ctx.projectId} and id=${sourceId} for update`
      )
      if (!current[0] || Number(current[0].revision) !== sourceRevision)
        throw new KnowledgeServiceError(
          "The source changed while indexing; the stale result was discarded.",
          "CONFLICT",
          409
        )
      for (const [ordinal, chunk] of chunks.entries()) {
        await tx.execute(sql`insert into build_knowledge_chunks (id,project_id,agent_id,source_id,revision,ordinal,content,metadata_json,search_vector,embedding_model,embedding)
          values (${`kc_${randomUUID().replaceAll("-", "")}`},${ctx.projectId},${source.agentId},${sourceId},${indexRevision},${ordinal},${chunk.content},${JSON.stringify(chunk.metadata)}::jsonb,to_tsvector('simple',${chunk.content}),${embeddings ? KNOWLEDGE_EMBEDDING_PROFILE : null},${embeddings ? JSON.stringify(embeddings[ordinal]) : null}::public.vector)`)
      }
      await tx.execute(
        sql`delete from build_knowledge_chunks where project_id=${ctx.projectId} and source_id=${sourceId} and revision <> ${indexRevision}`
      )
      await tx.execute(
        sql`delete from build_knowledge_crawl_pages p using build_knowledge_jobs j
          where p.project_id=${ctx.projectId} and p.job_id=j.id and j.source_id=${sourceId} and p.job_id<>${input.jobId}`
      )
      await tx.execute(sql`update build_knowledge_sources set
        status='ready',status_message=${statusMessage},active_revision=${indexRevision},content_text=${payload.text},content_json=${JSON.stringify(payload.metadata)}::jsonb,
        content_hash=${contentHash(payload.text)},last_indexed_at=${now},next_resync_at=${nextResync},updated_at=${now}
        where project_id=${ctx.projectId} and id=${sourceId} and revision=${sourceRevision}`)
      const completed = await query<{ id: string }>(
        tx,
        sql`update build_knowledge_jobs set status='succeeded',finished_at=${now},heartbeat_at=${now},lease_token=null,lease_expires_at=null,error=null where project_id=${ctx.projectId} and id=${input.jobId} and status='running' and lease_token=${claimed[0].leaseToken} and (lease_expires_at is null or lease_expires_at > now()) returning id`
      )
      if (!completed[0])
        throw new KnowledgeServiceError(
          "The knowledge job lease expired before its result could be published.",
          "CONFLICT",
          409
        )
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The knowledge job failed."
    await ctx.database.execute(
      sql`update build_knowledge_sources set status='error',status_message=${message.slice(0, 2_000)},updated_at=now() where project_id=${ctx.projectId} and id=${sourceId} and revision=${claimed[0].sourceRevision} and status='indexing' and exists (
        select 1 from build_knowledge_jobs j
        where j.project_id=${ctx.projectId} and j.id=${input.jobId}
          and j.status='running' and j.lease_token=${claimed[0].leaseToken}
          and (j.lease_expires_at is null or j.lease_expires_at > now())
      )`
    )
    await ctx.database.execute(
      sql`update build_knowledge_jobs set status='failed',finished_at=now(),heartbeat_at=now(),lease_token=null,lease_expires_at=null,error=${message.slice(0, 2_000)} where project_id=${ctx.projectId} and id=${input.jobId} and status='running' and lease_token=${claimed[0].leaseToken} and (lease_expires_at is null or lease_expires_at > now())`
    )
  }
  const rows = await query<JobRow>(
    ctx.database,
    sql`select id,source_id as "sourceId",kind,status,attempts,error,queued_at as "queuedAt",started_at as "startedAt",finished_at as "finishedAt",lease_expires_at as "leaseExpiresAt",heartbeat_at as "heartbeatAt" from build_knowledge_jobs where project_id=${ctx.projectId} and id=${input.jobId}`
  )
  if (!rows[0])
    throw new KnowledgeServiceError(
      "The knowledge job was removed with its source.",
      "NOT_FOUND",
      404
    )
  return jobFromRow(rows[0])
}

export async function runQueuedKnowledgeJobs(
  ctx: KnowledgeBuildContext,
  input: { limit?: number } = {}
) {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100)
  const jobs = await query<{ id: string }>(
    ctx.database,
    sql`select id from build_knowledge_jobs
      where project_id=${ctx.projectId}
        and (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at <= now())))
      order by queued_at asc,id asc limit ${limit}`
  )
  const results: KnowledgeJob[] = []
  for (const job of jobs)
    results.push(await runKnowledgeJob(ctx, { jobId: job.id }))
  return results
}

export async function enqueueDueKnowledgeResyncs(
  ctx: KnowledgeBuildContext,
  input: { now?: Date; limit?: number } = {}
) {
  assertContext(ctx)
  const now = input.now ?? new Date()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const rows = await query<{ id: string }>(
    ctx.database,
    sql`select id from build_knowledge_sources where project_id=${ctx.projectId} and status <> 'deleted' and kind in ('website','sitemap') and next_resync_at is not null and next_resync_at <= ${now.toISOString()} order by next_resync_at asc,id asc limit ${limit}`
  )
  const jobs: KnowledgeJob[] = []
  for (const row of rows)
    jobs.push(
      await enqueueKnowledgeIndex(ctx, { sourceId: row.id, kind: "resync" })
    )
  return jobs
}

export async function previewKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string }
) {
  assertContext(ctx)
  const source = await getSourceRow(ctx, input.sourceId)
  return {
    source: sourceFromRow(source),
    text: source.contentText ?? "",
    metadata: parseJson(source.contentJson),
  }
}

export async function exportKnowledgeSource(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string; format?: "text" | "json" }
) {
  assertContext(ctx)
  const source = await getSourceRow(ctx, input.sourceId)
  const text = source.contentText ?? ""
  if (input.format === "json")
    return {
      fileName: `${source.name.replace(/[^a-z0-9._-]+/gi, "-") || source.id}.json`,
      mimeType: "application/json",
      content: JSON.stringify(
        {
          source: sourceFromRow(source),
          text,
          metadata: parseJson(source.contentJson),
        },
        null,
        2
      ),
    }
  return {
    fileName: `${source.name.replace(/[^a-z0-9._-]+/gi, "-") || source.id}.txt`,
    mimeType: "text/plain",
    content: text,
  }
}

async function retrieveLexicalKnowledge(
  ctx: KnowledgeBuildContext,
  input: {
    agentId: string
    query: string
    limit?: number
    queryExpander?: KnowledgeQueryExpander
  }
): Promise<KnowledgeSearchResult[]> {
  assertContext(ctx)
  const queryText = normalizeKnowledgeText(input.query).slice(
    0,
    KNOWLEDGE_LIMITS.maxQueryCharacters
  )
  if (!queryText) return []
  const limit = Math.min(
    Math.max(input.limit ?? 8, 1),
    KNOWLEDGE_LIMITS.maxResults
  )
  const rows = await query<{
    chunkId: string
    sourceId: string
    agentId: string
    sourceName: string
    sourceKind: string
    content: string
    metadata: unknown
    score: number
    revision: number
  }>(
    ctx.database,
    sql`select
      c.id as "chunkId", c.source_id as "sourceId", c.agent_id as "agentId",
      s.name as "sourceName", s.kind as "sourceKind", c.content,
      c.metadata_json as metadata,
      ts_rank_cd(c.search_vector,plainto_tsquery('simple',${queryText})) as score,
      c.revision
    from build_knowledge_chunks c
    join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
    where c.project_id=${ctx.projectId} and c.agent_id=${input.agentId}
      and s.agent_id=${input.agentId} and s.status <> 'deleted' and c.revision=s.active_revision
      and c.search_vector @@ plainto_tsquery('simple',${queryText})
    order by score desc,c.source_id,c.ordinal limit ${limit}`
  )
  let selected = rows
  if (!selected.length) {
    const literalQuery = queryText.replace(/[\\%_]/g, "\\$&")
    selected = await query<(typeof rows)[number]>(
      ctx.database,
      sql`select
      c.id as "chunkId", c.source_id as "sourceId", c.agent_id as "agentId",
      s.name as "sourceName", s.kind as "sourceKind", c.content,
      c.metadata_json as metadata, 0.01::double precision as score, c.revision
      from build_knowledge_chunks c join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
      where c.project_id=${ctx.projectId} and c.agent_id=${input.agentId} and s.agent_id=${input.agentId} and s.status <> 'deleted' and c.revision=s.active_revision
        and c.content ilike ${`%${literalQuery}%`} escape '\\' order by c.source_id,c.ordinal limit ${limit}`
    )
  }
  if (!selected.length) {
    const terms = [
      ...queryText
        .toLocaleLowerCase()
        .matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu),
    ]
      .map((match) => match[0])
      .filter((term) => term.length >= 2)
      .slice(0, KNOWLEDGE_LIMITS.maxQueryTerms)
    if (terms.length) {
      // Natural questions contain common words that can swamp the useful
      // terms in a raw OR query. Remove common English/Portuguese words, then
      // favor distinct informative terms and page titles/URLs over repeated
      // navigation text. Corpus statistics stay scoped to this agent.
      const uniqueTerms = [...new Set(terms)]
      selected = await query<(typeof rows)[number]>(
        ctx.database,
        sql`with corpus as not materialized (
          select c.id,c.source_id,c.ordinal,c.search_vector,
            to_tsvector('simple',coalesce(c.metadata_json->>'title','') || ' ' ||
              regexp_replace(coalesce(c.metadata_json->>'url',''),'[^[:alnum:]]+',' ','g')) as metadata_vector
          from build_knowledge_chunks c join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
          where c.project_id=${ctx.projectId} and c.agent_id=${input.agentId}
            and s.agent_id=${input.agentId} and s.status<>'deleted' and c.revision=s.active_revision
        ), terms as materialized (
          select to_tsquery('simple',value || ':*') as term_query
          from jsonb_array_elements_text(${JSON.stringify(uniqueTerms)}::jsonb)
          where cardinality(ts_lexize('english_stem',value)) > 0
            and cardinality(ts_lexize('portuguese_stem',value)) > 0
        ), weighted as materialized (
          select terms.term_query,
            ln(1+(totals.total-frequency.matches+0.5)/(frequency.matches+0.5)) as weight
          from terms cross join (select count(*) as total from corpus) totals
          cross join lateral (select count(*) as matches from corpus where search_vector @@ terms.term_query) frequency
        ), ranked as (
          select corpus.id,sum((1 + 0.1 * ts_rank_cd(corpus.search_vector,weighted.term_query,32) +
            case when corpus.metadata_vector @@ weighted.term_query then 1 else 0 end)*weighted.weight) as score
          from corpus join weighted on corpus.search_vector @@ weighted.term_query
          group by corpus.id,corpus.source_id,corpus.ordinal
          order by score desc,corpus.source_id,corpus.ordinal limit ${limit}
        ) select
        c.id as "chunkId", c.source_id as "sourceId", c.agent_id as "agentId",
        s.name as "sourceName", s.kind as "sourceKind", c.content,
        c.metadata_json as metadata,ranked.score,
        c.revision
        from ranked join build_knowledge_chunks c on c.id=ranked.id
        join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
        order by ranked.score desc,c.source_id,c.ordinal`
      )
    }
  }
  if (!selected.length && input.queryExpander) {
    let expansions: readonly string[] = []
    try {
      expansions = await input.queryExpander({
        query: queryText,
        agentId: input.agentId,
        maxQueries: KNOWLEDGE_LIMITS.maxQueryExpansions,
        maxCharacters: KNOWLEDGE_LIMITS.maxQueryExpansionCharacters,
      })
    } catch {
      // Optional model expansion must never make deterministic retrieval fail.
    }
    const seen = new Set([queryText.toLocaleLowerCase()])
    const expandedResults: KnowledgeSearchResult[] = []
    for (const value of expansions) {
      if (typeof value !== "string") continue
      const expandedQuery = normalizeKnowledgeText(value).slice(
        0,
        KNOWLEDGE_LIMITS.maxQueryExpansionCharacters
      )
      const key = expandedQuery.toLocaleLowerCase()
      if (!expandedQuery || seen.has(key)) continue
      seen.add(key)
      expandedResults.push(
        ...(await retrieveLexicalKnowledge(ctx, {
          agentId: input.agentId,
          query: expandedQuery,
          limit,
        }))
      )
      if (seen.size - 1 >= KNOWLEDGE_LIMITS.maxQueryExpansions) break
    }
    const unique = new Map<string, KnowledgeSearchResult>()
    for (const result of expandedResults) {
      const previous = unique.get(result.chunkId)
      if (!previous || result.score > previous.score)
        unique.set(result.chunkId, result)
    }
    return [...unique.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.sourceId.localeCompare(right.sourceId)
      )
      .slice(0, limit)
  }
  return selected.map((row) => ({
    chunkId: row.chunkId,
    sourceId: row.sourceId,
    agentId: row.agentId,
    sourceName: row.sourceName,
    sourceKind: knowledgeSourceKindSchema.parse(row.sourceKind),
    content: row.content,
    metadata: parseJson(row.metadata),
    score: Number(row.score),
    revision: Number(row.revision),
  }))
}

/**
 * Rank fusion preserves exact terminology while adding semantic matches for
 * paraphrases. Both candidate sets enforce the same tenant/revision boundary.
 * No semantic provider failure is allowed to discard working lexical results.
 */
export async function retrieveKnowledge(
  ctx: KnowledgeBuildContext,
  input: {
    agentId: string
    query: string
    limit?: number
    queryExpander?: KnowledgeQueryExpander
    signal?: AbortSignal
  }
): Promise<KnowledgeSearchResult[]> {
  assertContext(ctx)
  const queryText = normalizeKnowledgeText(input.query).slice(
    0,
    KNOWLEDGE_LIMITS.maxQueryCharacters
  )
  if (!queryText) return []
  const limit = Math.min(
    Math.max(input.limit ?? 8, 1),
    KNOWLEDGE_LIMITS.maxResults
  )
  const candidateLimit = KNOWLEDGE_LIMITS.maxResults
  const [lexical, semantic] = await Promise.all([
    retrieveLexicalKnowledge(ctx, {
      ...input,
      query: queryText,
      limit: candidateLimit,
      queryExpander: undefined,
    }),
    (async (): Promise<KnowledgeSearchResult[]> => {
      try {
        const vector = await embedKnowledgeQuery(
          ctx,
          input.agentId,
          queryText,
          input.signal
        )
        if (!vector) return []
        const results = await query<KnowledgeSearchResult>(
          ctx.database,
          sql`
          select c.id as "chunkId",c.source_id as "sourceId",c.agent_id as "agentId",
            s.name as "sourceName",s.kind as "sourceKind",c.content,
            c.metadata_json as metadata,c.revision,
            1-(c.embedding <=> ${JSON.stringify(vector)}::public.vector) as score
          from build_knowledge_chunks c
          join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
          where c.project_id=${ctx.projectId} and c.agent_id=${input.agentId}
            and s.agent_id=${input.agentId} and s.status <> 'deleted' and c.revision=s.active_revision
            and c.embedding_model=${KNOWLEDGE_EMBEDDING_PROFILE}
            and c.embedding is not null
            and 1-(c.embedding <=> ${JSON.stringify(vector)}::public.vector) >= 0.3
          order by c.embedding <=> ${JSON.stringify(vector)}::public.vector,c.source_id,c.ordinal
          limit ${candidateLimit}
        `
        )
        return results
      } catch {
        return []
      }
    })(),
  ])
  let candidates: KnowledgeSearchResult[]
  if (!semantic.length) {
    candidates =
      !lexical.length && input.queryExpander
        ? await retrieveLexicalKnowledge(ctx, {
            ...input,
            query: queryText,
            limit: candidateLimit,
          })
        : lexical
  } else if (!lexical.length) {
    candidates = semantic
  } else {
    const fused = new Map<string, KnowledgeSearchResult>()
    for (const results of [lexical, semantic]) {
      results.forEach((result, rank) => {
        const previous = fused.get(result.chunkId)
        fused.set(result.chunkId, {
          ...result,
          score: (previous?.score ?? 0) + 1 / (60 + rank + 1),
        })
      })
    }
    candidates = [...fused.values()].sort(
      (left, right) =>
        right.score - left.score || left.chunkId.localeCompare(right.chunkId)
    )
  }
  return rankKnowledgeCandidates(ctx, {
    query: queryText,
    candidates,
    limit,
    signal: input.signal,
  })
}

/**
 * Runtime-facing grounding adapter. The agent runner can pass `context` as a
 * bounded system/user context block and retain `citations` in the turn
 * snapshot. Hybrid candidates are deduplicated and reranked before selecting
 * the context. Only indexed chunks become citations; generation stays in the runtime.
 */
export async function retrieveGroundedKnowledge(
  ctx: KnowledgeBuildContext,
  input: {
    agentId: string
    query: string
    limit?: number
    queryExpander?: KnowledgeQueryExpander
    signal?: AbortSignal
  }
) {
  const results = await retrieveKnowledge(ctx, input)
  const context = results
    .map((result, index) => {
      const url =
        typeof result.metadata.url === "string"
          ? `\nSource URL: ${result.metadata.url}`
          : ""
      return `[${index + 1}] ${result.sourceName}${url}\n${result.content}`
    })
    .join("\n\n")
  const snapshotId = results.length
    ? `knowledge:${createHash("sha256")
        .update(
          JSON.stringify(
            results.map((result) => ({
              chunkId: result.chunkId,
              sourceId: result.sourceId,
              revision: result.revision,
              content: result.content,
            }))
          )
        )
        .digest("hex")}`
    : null
  return {
    context,
    // Aliases match the runtime's channel-neutral grounding contract while
    // `context` remains useful to MCP callers that need citations separately.
    text: context,
    documents: results.map((result, index) => ({
      rank: index + 1,
      score: result.score,
      chunkId: result.chunkId,
      sourceId: result.sourceId,
      sourceName: result.sourceName,
      sourceKind: result.sourceKind,
      content: result.content,
      metadata: result.metadata,
      revision: result.revision,
    })),
    snapshotId,
    citations: results.map((result, index) => ({
      index: index + 1,
      chunkId: result.chunkId,
      sourceId: result.sourceId,
      sourceName: result.sourceName,
      sourceKind: result.sourceKind,
      metadata: result.metadata,
      revision: result.revision,
    })),
    results,
  }
}

/** Cross-project worker admission; excluded organizations retain all queued work. */
export async function listKnowledgeProjectsWithPendingWork(
  database: TracerDatabase,
  limit = 50
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Knowledge work limit must be between 1 and 1000.")
  const pending = await database.execute<{ projectId: string }>(sql`
    select project_id as "projectId" from (
      select project_id, queued_at as due from build_knowledge_jobs
      where status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at <= now()))
      union all
      select project_id, next_resync_at as due from build_knowledge_sources
      where status <> 'deleted' and kind in ('website','sitemap') and next_resync_at <= now()
    ) work where ${enabledBuildProject(sql`work.project_id`)}
    group by project_id order by min(due), project_id limit ${limit}
  `)
  return pending.rows.map((row) => row.projectId)
}
