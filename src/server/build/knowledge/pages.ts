import { sql } from "drizzle-orm"
import {
  KNOWLEDGE_LIMITS,
  parseKnowledgeJson,
  type KnowledgePage,
  type KnowledgePageDetail,
  type KnowledgePageList,
} from "@/src/lib/build/knowledge"
import { KnowledgeServiceError, type KnowledgeBuildContext } from "./service"

async function pageCatalog(ctx: KnowledgeBuildContext, sourceId: string) {
  if (!ctx.projectId || !sourceId?.trim())
    throw new KnowledgeServiceError("projectId and sourceId are required.")
  // Keep the source's potentially large combined content out of list reads.
  const result = await ctx.database.execute(sql`
    select active_revision as revision, content_json->'pages' as pages
    from build_knowledge_sources
    where project_id=${ctx.projectId} and id=${sourceId}
      and status <> 'deleted' and kind in ('website','sitemap')
  `)
  const row = result.rows[0] as { revision: number; pages: unknown } | undefined
  if (!row)
    throw new KnowledgeServiceError("Website source not found.", "NOT_FOUND")
  const items: KnowledgePage[] = []
  for (const value of Array.isArray(row.pages) ? row.pages : []) {
    const page = parseKnowledgeJson(value)
    if (typeof page.url !== "string") continue
    items.push({
      url: page.url,
      title: typeof page.title === "string" ? page.title : null,
      fetchedAt: typeof page.fetchedAt === "string" ? page.fetchedAt : null,
      contentType:
        typeof page.contentType === "string" ? page.contentType : null,
    })
  }
  return { items, revision: Number(row.revision) }
}

export async function listKnowledgePages(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string; search?: string; offset?: number; limit?: number }
): Promise<KnowledgePageList> {
  const { items, revision } = await pageCatalog(ctx, input.sourceId)
  const search = input.search?.trim().toLowerCase() ?? ""
  const filtered = items
    .filter((page) =>
      `${page.url}\n${page.title ?? ""}`.toLowerCase().includes(search)
    )
    .sort((a, b) => a.url.localeCompare(b.url))
  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)))
  return {
    items: filtered.slice(offset, offset + limit),
    total: items.length,
    filteredTotal: filtered.length,
    revision,
  }
}

export async function getKnowledgePage(
  ctx: KnowledgeBuildContext,
  input: { sourceId: string; url: string; revision: number }
): Promise<KnowledgePageDetail> {
  const catalog = await pageCatalog(ctx, input.sourceId)
  if (input.revision !== catalog.revision)
    throw new KnowledgeServiceError(
      "The website index changed. Refresh the page list and try again.",
      "CONFLICT"
    )
  const page = catalog.items.find((item) => item.url === input.url)
  if (!page)
    throw new KnowledgeServiceError("Indexed page not found.", "NOT_FOUND")

  // A successful crawl retains the complete extracted page. Match the active
  // page's fetch time so a newer, unfinished resync cannot leak into this view.
  const result = await ctx.database.execute(sql`
    select p.page_json->'page'->>'text' as text
    from build_knowledge_crawl_pages p
    join build_knowledge_jobs j on j.project_id=p.project_id and j.id=p.job_id
    join build_knowledge_sources s on s.project_id=j.project_id and s.id=j.source_id
    where p.project_id=${ctx.projectId} and j.source_id=${input.sourceId}
      and j.status='succeeded' and s.active_revision=${input.revision}
      and s.status <> 'deleted'
      and p.page_json->'page'->>'url'=${page.url}
      and p.page_json->'page'->>'fetchedAt'=${page.fetchedAt}
    order by j.finished_at desc limit 1
  `)
  const text = (result.rows[0] as { text?: string } | undefined)?.text
  if (typeof text === "string")
    return {
      ...page,
      revision: catalog.revision,
      markdown: text,
      contentOrigin: "crawl",
    }

  // Source edits may retire crawl checkpoints while keeping the previous
  // active index available. Its ordered chunks are still inspectable.
  const chunks = await ctx.database.execute(sql`
    select c.content from build_knowledge_chunks c
    join build_knowledge_sources s on s.project_id=c.project_id and s.id=c.source_id
    where c.project_id=${ctx.projectId} and c.source_id=${input.sourceId}
      and c.revision=s.active_revision and s.active_revision=${input.revision}
      and s.status <> 'deleted' and c.metadata_json->>'url'=${page.url}
    order by c.ordinal
  `)
  if (!chunks.rows.length)
    throw new KnowledgeServiceError(
      "Page content is no longer available. Refresh the page list and try again.",
      "NOT_FOUND"
    )
  let markdown = ""
  for (const row of chunks.rows as { content: string }[]) {
    if (!markdown) {
      markdown = row.content
      continue
    }
    let overlap = Math.min(
      KNOWLEDGE_LIMITS.chunkOverlapCharacters,
      row.content.length,
      markdown.length
    )
    while (overlap > 0 && !markdown.endsWith(row.content.slice(0, overlap)))
      overlap--
    markdown += overlap ? row.content.slice(overlap) : `\n\n${row.content}`
  }
  return {
    ...page,
    revision: catalog.revision,
    markdown,
    contentOrigin: "chunks",
  }
}
