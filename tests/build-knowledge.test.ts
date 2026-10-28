import { afterEach, expect, spyOn, test } from "bun:test"
import { Buffer } from "node:buffer"
import assert from "node:assert/strict"
import { sql } from "drizzle-orm"

import {
  chunkKnowledgeText,
  normalizeKnowledgeText,
} from "@/src/lib/build/knowledge"
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  exportKnowledgeSource,
  getKnowledgeSource,
  enqueueKnowledgeIndex,
  heartbeatKnowledgeJob,
  retrieveKnowledge,
  retrieveGroundedKnowledge,
  runKnowledgeJob,
  runQueuedKnowledgeJobs,
  updateKnowledgeSource,
} from "@/src/server/build/knowledge"
import { assertPublicUrl } from "@/src/server/build/knowledge/crawler"
import { getKnowledgePage, listKnowledgePages } from "@/src/server/build/knowledge/pages"
import * as publicHttp from "@/src/server/build/http"
import {
  extractDocumentText,
  extractHtmlText,
} from "@/src/server/build/knowledge/extract"
import { createKnowledgeQueryExpander } from "@/src/server/build/knowledge/query-expansion"
import { backfillKnowledgeEmbeddings } from "@/src/server/build/knowledge/embeddings"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import { createAgent } from "@/src/server/build/agents"
import {
  createTracerDatabase,
  closeTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

import { pdfFixture } from "./helpers/build-documents"

function docxFixture() {
  return new Uint8Array(
    Buffer.from(
      "UEsDBBQAAAAIAPm2Ul15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgA+bZSXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAPm2Ul3G6WYFpQAAANsAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjrEOgjAQhl+l6S5FB2MIhUHj6qKJa20PaELvmraIvL0UB5fvz93l/3J1+3Eje0OIllDyfVFyBqjJWOwlf9yvuxNnMSk0aiQEyReIvG3quTKkJweY2CrAWM2SDyn5SoioB3AqFuQB11tHwam0jqEXMwXjA2mIcfW7URzK8iicssiz8kVmyekzQkZqLrfzkwXoJjTM02j1Uou8zwwb/cZfV/z/ar5QSwECFAMUAAAACAD5tlJdeW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAPm2Ul2b/TfqrQAAACkBAAALAAAAAAAAAAAAAACAARkBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAPm2Ul3G6WYFpQAAANsAAAARAAAAAAAAAAAAAACAAe8BAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAADDAgAAAAA=",
      "base64"
    )
  )
}

/**
 * Authoring gate: these tests own externally observable knowledge behavior
 * (bounded extraction, SSRF rejection, durable indexing/retrieval and revoke).
 * They fail on the corresponding unsafe/unindexed implementation and no
 * existing test reaches these Build tables or parsers. No test-only seam is
 * introduced: the integration case uses the real PostgreSQL service boundary.
 */

test("normalizes and bounds knowledge chunks at the retrieval boundary", () => {
  const normalized = normalizeKnowledgeText("  One\r\n\r\n\r\nTwo\t words  ")
  expect(normalized).toBe("One\n\n\nTwo words")
  const chunks = chunkKnowledgeText("Paragraph one.\n\nParagraph two.", {
    maxCharacters: 16,
    overlapCharacters: 3,
    maxChunks: 10,
  })
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every((chunk) => chunk.length <= 16)).toBe(true)
})

test("extracts HTML and text PDFs while rejecting private source URLs", async () => {
  const html = extractHtmlText(
    "<html><head><title>Help</title><style>x</style></head><body><nav>Menu noise</nav><h1>Refunds</h1><p>Seven days.</p></body></html>"
  )
  expect(html.title).toBe("Help")
  expect(html.text).toContain("Refunds")
  expect(html.text).toContain("Seven days.")
  expect(html.text).not.toContain("Menu noise")

  const pdf = pdfFixture()
  expect(
    (await extractDocumentText({ fileName: "policy.pdf", bytes: pdf })).text
  ).toContain("Refund policy")
  expect(
    (
      await extractDocumentText({
        fileName: "policy.docx",
        bytes: docxFixture(),
      })
    ).text
  ).toContain("DOCX refund policy")

  await assert.rejects(
    assertPublicUrl("http://127.0.0.1/private"),
    /public internet|private|reserved/i
  )
  await assert.rejects(
    assertPublicUrl("http://169.254.169.254/latest/meta-data"),
    /public internet|private|reserved/i
  )
})

test("keeps malformed compressed documents in the parent preflight", async () => {
  await assert.rejects(
    extractDocumentText({
      fileName: "malformed.docx",
      bytes: new Uint8Array(64),
    }),
    /DOCX archive is malformed/i
  )
})

test("bounds model query expansion to search strings", async () => {
  const captured: { temperature?: unknown; maxOutputTokens?: unknown } = {}
  const expander = createKnowledgeQueryExpander(
    { database: {} as TracerDatabase, projectId: "project-test" },
    {
      model: "openai/gpt-4.1-mini",
      resolveModel: async () => ({}) as never,
      generateText: (async (input: Record<string, unknown>) => {
        captured.temperature = input.temperature
        captured.maxOutputTokens = input.maxOutputTokens
        return {
          text: '1. "refund policy"\nrefund policy\n- purchase refund window',
        }
      }) as never,
    }
  )
  const values = await expander({
    query: "Como funciona o reembolso?",
    agentId: "agent-test",
    maxQueries: 3,
    maxCharacters: 500,
  })
  expect(values).toEqual(["refund policy", "purchase refund window"])
  expect(captured.temperature).toBe(0)
  expect(captured.maxOutputTokens).toBe(128)
})

const integrationEnabled = Boolean(process.env.DATOOL_TEST_DATABASE_URL)
const databases = new Set<TracerDatabase>()
const fixtures = new Set<IsolatedPostgres>()

afterEach(async () => {
  await Promise.all(
    [...databases].map((database) => closeTracerDatabase(database))
  )
  databases.clear()
  await Promise.all([...fixtures].map((fixture) => fixture.close()))
  fixtures.clear()
})

const dbTest = (name: string, fn: () => Promise<void>, timeout?: number) => {
  if (integrationEnabled) test(name, fn, timeout ?? 30_000)
}

dbTest(
  "a website source resumes saved pages after lease loss and indexes its full sitemap",
  async () => {
    const fixture = await createIsolatedPostgres()
    fixtures.add(fixture)
    await migrateIsolatedPostgres(fixture)
    await seedTestWorkspace(fixture)
    const database = createTracerDatabase(fixture.databaseUrl, {
      projectId: fixture.projectId,
      schema: fixture.schema,
    })
    databases.add(database)
    const context = { database, projectId: fixture.projectId }
    const agent = await createAgent(context, {
      name: "Website agent",
      slug: "website",
    })
    let interrupted = false
    let rootRequests = 0
    const pageMarkdown = [
      "# Onboarding",
      "Zirconium support includes weekend onboarding.",
      ...Array.from({ length: 80 }, (_, index) => `## Step ${index + 1}\nRead the **onboarding guide** and complete the scheduled setup.`),
      "[Linked documentation](/linked-only?utm_source=test#details)",
    ].join("\n\n")
    const transport = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
      async (url, options) => {
        const path = new URL(url).pathname
        const markdown =
          path === "/page-129" &&
          new Headers(options?.headers).get("accept")?.includes("text/markdown")
        if (path === "/") rootRequests++
        // Interrupt in the second batch, after the root checkpoint is durable.
        if (path === "/page-8" && !interrupted) {
          interrupted = true
          await database.execute(
            sql`update build_knowledge_jobs set lease_expires_at=now()-interval '1 second' where project_id=${context.projectId} and status='running'`
          )
        }
        const body =
          path === "/sitemap.xml"
            ? `<sitemapindex><sitemap><loc>https://example.test/pages.xml</loc></sitemap></sitemapindex>`
            : path === "/pages.xml"
              ? `<urlset>${Array.from({ length: 130 }, (_, i) => `<url><loc>https://example.test/page-${i}</loc></url>`).join("")}</urlset>`
              : markdown
                ? pageMarkdown
                : `<html><title>${path}</title><p>Reference content for ${path}. ${path === "/linked-only" ? "Cobalt training includes remote workshops." : "Standard documentation."}</p>${path === "/" ? '<a href="https://unrelated.test/private">External</a>' : ""}</html>`
        return {
          url,
          status: 200,
          headers: new Headers({
            "content-type": path.endsWith(".xml")
              ? "application/xml"
              : markdown
                ? "text/markdown"
                : "text/html",
          }),
          body: new TextEncoder().encode(body),
        }
      }
    )
    try {
      const source = await createKnowledgeSource(context, {
        agentId: agent.id,
        name: "Entire website",
        kind: "website",
        url: "https://example.test",
        config: { pacingMs: 0, maxPages: 100 },
      })
      await runQueuedKnowledgeJobs(context)
      const jobs = await runQueuedKnowledgeJobs(context)
      expect(jobs[0].status).toBe("succeeded")
      expect(rootRequests).toBe(1)
      await updateKnowledgeSource(context, {
        sourceId: source.id,
        expectedRevision: 1,
        config: { maxPages: 160, pacingMs: 0 },
      })
      expect((await runQueuedKnowledgeJobs(context))[0].status).toBe(
        "succeeded"
      )
      expect(rootRequests).toBe(1)
      const ready = await getKnowledgeSource(context, { sourceId: source.id })
      expect(ready.text).toContain(
        "Zirconium support includes weekend onboarding."
      )
      expect(ready.text).toContain("Cobalt training includes remote workshops.")
      expect(ready.statusMessage).toContain("132 pages indexed.")
      const results = await retrieveKnowledge(context, {
        agentId: agent.id,
        query: "Zirconium weekend onboarding",
      })
      expect(results[0]?.metadata.url).toBe("https://example.test/page-129")

      // The page browser owns discovery beyond one result page and exact
      // stored content; retrieval tests alone cannot establish these contracts.
      const first = await listKnowledgePages(context, { sourceId: source.id, limit: 100 })
      const second = await listKnowledgePages(context, { sourceId: source.id, limit: 100, offset: 100 })
      expect(first.total).toBe(132)
      expect(first.items).toHaveLength(100)
      expect(second.items).toHaveLength(32)
      expect(new Set([...first.items, ...second.items].map((page) => page.url)).size).toBe(132)
      const matching = await listKnowledgePages(context, { sourceId: source.id, search: "PAGE-129" })
      expect(matching.items.map((page) => page.url)).toEqual(["https://example.test/page-129"])
      expect((await listKnowledgePages(context, { sourceId: source.id, search: "missing-page" })).filteredTotal).toBe(0)
      const detailInput = { sourceId: source.id, url: matching.items[0].url, revision: first.revision }
      const page = await getKnowledgePage(context, detailInput)
      expect(page.markdown).toBe(pageMarkdown)
      expect(page.contentOrigin).toBe("crawl")
      await assert.rejects(getKnowledgePage(context, { ...detailInput, revision: first.revision + 1 }), /index changed/i)
      await assert.rejects(getKnowledgePage(context, { ...detailInput, url: "https://example.test/unindexed" }), /not found/i)
      const otherProject = { ...context, projectId: crypto.randomUUID() }
      await assert.rejects(listKnowledgePages(otherProject, { sourceId: source.id }), /not found/i)
      await assert.rejects(getKnowledgePage(otherProject, detailInput), /not found/i)

      // Retired crawl checkpoints must not hide the still-active retrieval index.
      await database.execute(sql`delete from build_knowledge_crawl_pages where project_id=${context.projectId}`)
      const fallback = await getKnowledgePage(context, detailInput)
      expect(fallback.markdown).toBe(pageMarkdown)
      expect(fallback.contentOrigin).toBe("chunks")
    } finally {
      transport.mockRestore()
    }
  },
  30_000
)

// The real database and SDK own indexing, ranking, revisions and tenant filters.
// Fixed vectors at the HTTP boundary isolate those contracts from a paid model;
// real-model paraphrase quality is validated separately against indexed content.
dbTest("hybrid knowledge retrieves paraphrases, isolates agents and retains the index on provider failure", async () => {
  const fixture = await createIsolatedPostgres()
  fixtures.add(fixture)
  await migrateIsolatedPostgres(fixture)
  await seedTestWorkspace(fixture)
  const database = createTracerDatabase(fixture.databaseUrl, {
    projectId: fixture.projectId, schema: fixture.schema,
  })
  databases.add(database)
  const context = { database, projectId: fixture.projectId }
  const agent = await createAgent(context, { name: "Support", slug: "support" })
  const other = await createAgent(context, { name: "Private support", slug: "private" })
  const previousSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = "knowledge-test-only-encryption-secret-1234"
  const key = encryptProviderKey("knowledge-test-key", fixture.projectId, "openai")
  await database.execute(sql`insert into project_model_provider(project_id,provider,encrypted_api_key)
    values (${fixture.projectId},'openai',${key})`)
  let failing = false
  let embeddedInputs = 0
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings")
    if (failing) return Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 })
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string }
    expect(body.model).toBe("text-embedding-3-small")
    embeddedInputs += body.input.length
    return Response.json({
      data: body.input.map((text, index) => ({
        index,
        embedding: [text.includes("banana") ? -1 : 1, ...Array(1535).fill(0)],
      })),
      usage: { prompt_tokens: 10, total_tokens: 10 },
    })
  })
  try {
    const source = await createKnowledgeSource(context, {
      agentId: agent.id, name: "Returns", kind: "text",
      text: "Customers can request a refund within seven days of purchase.",
    })
    await createKnowledgeSource(context, {
      agentId: other.id, name: "Private policy", kind: "text",
      text: "Private refunds require internal approval.",
    })
    expect((await runQueuedKnowledgeJobs(context)).every((job) => job.status === "succeeded")).toBe(true)
    const paraphrase = { agentId: agent.id, query: "Can I get my money back?" }
    const grounded = await retrieveGroundedKnowledge(context, paraphrase)
    expect(grounded.documents.map((doc) => doc.sourceId)).toEqual([source.id])
    expect(grounded.text).toContain("seven days")
    expect(grounded.snapshotId?.startsWith("knowledge:")).toBe(true)
    expect(await retrieveKnowledge(context, { agentId: agent.id, query: "banana cultivation" })).toEqual([])

    // A foreign project must not retrieve an otherwise matching vector.
    expect(await retrieveKnowledge({ ...context, projectId: "foreign-project" }, paraphrase)).toEqual([])
    const beforeRefresh = embeddedInputs
    await enqueueKnowledgeIndex(context, { sourceId: source.id })
    expect((await runQueuedKnowledgeJobs(context))[0].status).toBe("succeeded")
    expect(embeddedInputs).toBe(beforeRefresh)

    failing = true
    expect((await retrieveKnowledge(context, { agentId: agent.id, query: "refund" }))[0].sourceId).toBe(source.id)
    await updateKnowledgeSource(context, {
      sourceId: source.id, expectedRevision: 1,
      text: "Customers can request a refund within thirty days of purchase.",
    })
    expect((await runQueuedKnowledgeJobs(context))[0].status).toBe("failed")
    failing = false
    expect((await retrieveGroundedKnowledge(context, paraphrase)).text).toContain("seven days")
    await enqueueKnowledgeIndex(context, { sourceId: source.id })
    expect((await runQueuedKnowledgeJobs(context))[0].status).toBe("succeeded")
    const updated = await retrieveGroundedKnowledge(context, paraphrase)
    expect(updated.text).toContain("thirty days")
    expect(updated.text).not.toContain("seven days")
    expect(updated.snapshotId).not.toBe(grounded.snapshotId)
    await deleteKnowledgeSource(context, { sourceId: source.id })
    expect(await retrieveKnowledge(context, paraphrase)).toEqual([])
  } finally {
    transport.mockRestore()
    if (previousSecret === undefined) delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousSecret
  }
}, 30_000)

dbTest("knowledge embedding backfill resumes existing chunks without recrawling and rejects malformed provider batches", async () => {
  const fixture = await createIsolatedPostgres()
  fixtures.add(fixture)
  await migrateIsolatedPostgres(fixture)
  await seedTestWorkspace(fixture)
  const database = createTracerDatabase(fixture.databaseUrl, {
    projectId: fixture.projectId, schema: fixture.schema,
  })
  databases.add(database)
  const context = { database, projectId: fixture.projectId }
  const agent = await createAgent(context, { name: "Legacy knowledge", slug: "legacy" })
  const source = await createKnowledgeSource(context, {
    agentId: agent.id, name: "Existing pages", kind: "text",
    text: Array.from({ length: 90 }, (_, index) => `Section ${index}. ${"Policy information. ".repeat(65)}`).join("\n\n"),
  })
  await runQueuedKnowledgeJobs(context)
  const ready = await getKnowledgeSource(context, { sourceId: source.id })
  expect(ready.chunkCount).toBeGreaterThan(64)
  const previousSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = "knowledge-test-only-encryption-secret-1234"
  const key = encryptProviderKey("knowledge-test-key", fixture.projectId, "openai")
  await database.execute(sql`insert into project_model_provider(project_id,provider,encrypted_api_key)
    values (${fixture.projectId},'openai',${key})`)
  let calls = 0
  let malformed = true
  const transport = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings")
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    expect(body.input.length).toBeLessThanOrEqual(64)
    calls += 1
    return Response.json({
      data: body.input.map((_, index) => ({
        index,
        embedding: malformed && calls > 1 ? [1, 0] : [1, ...Array(1535).fill(0)],
      })),
      usage: { prompt_tokens: 10, total_tokens: 10 },
    })
  })
  try {
    await assert.rejects(backfillKnowledgeEmbeddings(context, { agentId: agent.id }), /invalid vector/)
    const partial = await database.execute<{ count: number }>(sql`
      select count(*)::int as count from build_knowledge_chunks
      where project_id=${fixture.projectId} and source_id=${source.id} and embedding is not null
    `)
    expect(partial.rows[0].count).toBe(64)
    malformed = false
    const resumed = await backfillKnowledgeEmbeddings(context, { agentId: agent.id })
    expect(resumed.embedded).toBe(ready.chunkCount! - 64)
    const beforeNoop = calls
    expect(await backfillKnowledgeEmbeddings(context, { agentId: agent.id })).toEqual({ embedded: 0 })
    expect(calls).toBe(beforeNoop)
    expect((await getKnowledgeSource(context, { sourceId: source.id })).activeRevision).toBe(ready.activeRevision)
    expect((await retrieveKnowledge(context, { agentId: agent.id, query: "Completely different wording" }))[0].sourceId).toBe(source.id)
  } finally {
    transport.mockRestore()
    if (previousSecret === undefined) delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousSecret
  }
}, 30_000)

// This service-level case owns final context selection: duplicate passages must
// not consume slots, reranking must preserve provenance, and provider failure
// must retain useful retrieval. The HTTP mock is the external SDK boundary;
// lexical selection, credential scoping and context assembly use the real DB.
dbTest(
  "knowledge deduplicates and reranks candidates with a bounded, provenance-preserving fallback",
  async () => {
    const fixture = await createIsolatedPostgres()
    fixtures.add(fixture)
    await migrateIsolatedPostgres(fixture)
    await seedTestWorkspace(fixture)
    const database = createTracerDatabase(fixture.databaseUrl, {
      projectId: fixture.projectId,
      schema: fixture.schema,
    })
    databases.add(database)
    const context = { database, projectId: fixture.projectId }
    const agent = await createAgent(context, {
      name: "Ranked support",
      slug: "ranked",
    })
    const other = await createAgent(context, {
      name: "Private support",
      slug: "private",
    })
    const passages = [
      {
        name: "Noise",
        text: `${"Refund policy. ".repeat(20)}Warehouse labels use blue ink.`,
        url: "https://example.test/labels",
      },
      {
        name: "Markdown returns",
        text: "Refund policy: purchases can be returned within seven days.",
        url: "https://example.test/returns.md",
      },
      {
        name: "Returns",
        text: "Refund policy: purchases can be returned\nwithin seven days.",
        url: "https://example.test/returns",
      },
      {
        name: "Return steps",
        text: "Refund policy: contact support with the receipt to start a return.",
        url: "https://example.test/returns",
      },
    ]
    const sources = []
    for (const passage of passages) {
      sources.push(
        await createKnowledgeSource(context, {
          agentId: agent.id,
          name: passage.name,
          kind: "text",
          text: passage.text,
        })
      )
    }
    await createKnowledgeSource(context, {
      agentId: other.id,
      name: "Private",
      kind: "text",
      text: "Private refund policy.",
    })
    await runQueuedKnowledgeJobs(context)
    // Seed the source provenance normally supplied by the website crawler.
    for (const [index, source] of sources.entries())
      await database.execute(sql`update build_knowledge_chunks
      set metadata_json=${JSON.stringify({ url: passages[index].url })}::jsonb
      where project_id=${context.projectId} and source_id=${source.id}`)

    const input = { agentId: agent.id, query: "refund policy", limit: 3 }
    const fallback = await retrieveGroundedKnowledge(context, input)
    expect(fallback.results).toHaveLength(3)
    expect(fallback.results[0].sourceId).toBe(sources[0].id)
    expect(fallback.results.map((row) => row.sourceId).sort()).toEqual(
      [sources[0].id, sources[2].id, sources[3].id].sort()
    )
    expect(fallback.citations.map((item) => item.metadata.url)).not.toContain(
      passages[1].url
    )
    const previousSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
      "knowledge-test-only-encryption-secret-1234"
    let mode = "valid"
    let calls = 0
    let timedOut = false
    const cancelled = new AbortController()
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      async (url, init) => {
        expect(new URL(String(url)).hostname).toBe("ai-gateway.vercel.sh")
        expect(String(url).endsWith("/reranking-model")).toBe(true)
        calls++
        const body = JSON.parse(String(init?.body)) as {
          query: string
          topN: number
          documents: { values: string[] }
        }
        const documents = body.documents.values
        expect(documents).toHaveLength(3)
        expect(documents.join("\n")).not.toContain("Private")
        const returnsIndex = documents.findIndex((text) =>
          text.includes("seven days")
        )
        const stepsIndex = documents.findIndex((text) =>
          text.includes("receipt")
        )
        const noiseIndex = documents.findIndex((text) =>
          text.includes("Warehouse")
        )
        const ranking = [
          { index: returnsIndex, relevanceScore: 0.95 },
          { index: stepsIndex, relevanceScore: 0.8 },
          { index: noiseIndex, relevanceScore: 0.1 },
        ].slice(0, body.topN)
        if (mode === "error")
          return Response.json({ error: "Unavailable" }, { status: 503 })
        if (mode === "partial")
          return Response.json({ ranking: ranking.slice(0, 1) })
        if (mode === "duplicate")
          return Response.json({ ranking: ranking.map(() => ranking[0]) })
        if (mode === "invalid-index")
          return Response.json({
            ranking: [{ index: 99, relevanceScore: 1 }, ...ranking.slice(1)],
          })
        if (mode === "malformed") return Response.json({ ranking: "invalid" })
        if (mode === "timeout" || mode === "cancel") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                timedOut = mode === "timeout"
                reject(new DOMException("Aborted", "AbortError"))
              },
              { once: true }
            )
            if (mode === "cancel") queueMicrotask(() => cancelled.abort())
          })
        }
        return Response.json({ ranking })
      }
    )
    try {
      await database.execute(sql`insert into project_model_provider(project_id,provider,encrypted_api_key)
      values (${context.projectId},'vercel-ai-gateway',${encryptProviderKey("knowledge-test-key", context.projectId, "vercel-ai-gateway")})`)
      const ranked = await retrieveGroundedKnowledge(context, input)
      expect(ranked.results.map((item) => item.sourceId)).toEqual([
        sources[2].id,
        sources[3].id,
        sources[0].id,
      ])
      expect(ranked.citations[0].metadata.url).toBe(
        "https://example.test/returns"
      )
      expect(ranked.text.indexOf("seven days")).toBeLessThan(
        ranked.text.indexOf("Warehouse")
      )
      expect(ranked.snapshotId).not.toBe(fallback.snapshotId)
      expect(
        (await retrieveKnowledge(context, { ...input, limit: 1 }))[0].sourceId
      ).toBe(sources[2].id)
      for (const failure of [
        "error",
        "partial",
        "duplicate",
        "invalid-index",
        "malformed",
        "timeout",
      ]) {
        mode = failure
        const beforeCalls = calls
        expect(await retrieveGroundedKnowledge(context, input)).toEqual(
          fallback
        )
        expect(calls - beforeCalls).toBe(1)
      }
      expect(timedOut).toBe(true)
      mode = "cancel"
      expect(
        await retrieveGroundedKnowledge(context, {
          ...input,
          signal: cancelled.signal,
        })
      ).toEqual(fallback)
      const beforeCancelled = calls
      expect(
        await retrieveGroundedKnowledge(context, {
          ...input,
          signal: cancelled.signal,
        })
      ).toEqual(fallback)
      expect(calls).toBe(beforeCancelled)

      const beforeForeign = calls
      expect(
        await retrieveKnowledge(
          { ...context, projectId: "foreign-project" },
          input
        )
      ).toEqual([])
      expect(calls).toBe(beforeForeign)
    } finally {
      transport.mockRestore()
      if (previousSecret === undefined)
        delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
      else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousSecret
    }
  },
  30_000
)

dbTest(
  "indexes, retrieves, updates, exports and revokes a project-scoped source",
  async () => {
    const fixture = await createIsolatedPostgres()
    fixtures.add(fixture)
    await migrateIsolatedPostgres(fixture)
    await seedTestWorkspace(fixture)
    const database = createTracerDatabase(fixture.databaseUrl, {
      projectId: fixture.projectId,
      schema: fixture.schema,
    })
    databases.add(database)
    const context = {
      database,
      projectId: fixture.projectId,
      organizationId: fixture.organizationId,
    }
    const agent = await createAgent(context, {
      name: "Support agent",
      slug: "support",
    })

    const source = await createKnowledgeSource(context, {
      agentId: agent.id,
      name: "Refund policy",
      kind: "text",
      text: "Customers can request a refund within seven days of purchase.",
    })
    expect(source.status).toBe("pending")
    const jobs = await runQueuedKnowledgeJobs(context)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe("succeeded")

    const ready = await getKnowledgeSource(context, { sourceId: source.id })
    expect(ready.status).toBe("ready")
    expect(ready.activeRevision).toBe(1)
    expect(ready.chunkCount).toBeGreaterThan(0)
    const results = await retrieveKnowledge(context, {
      agentId: agent.id,
      query: "refund seven days",
    })
    expect(results[0]?.sourceId).toBe(source.id)
    expect(results[0]?.content).toContain("seven days")
    expect(results[0]?.metadata).toEqual({})

    const broadMatch = await retrieveKnowledge(context, {
      agentId: agent.id,
      query: "refund window",
    })
    expect(broadMatch[0]?.sourceId).toBe(source.id)
    let expansionCalls = 0
    const expandedMatch = await retrieveKnowledge(context, {
      agentId: agent.id,
      query: "Como funciona o reembolso?",
      queryExpander: async ({ maxQueries, maxCharacters }) => {
        expansionCalls += 1
        expect(maxQueries).toBe(3)
        expect(maxCharacters).toBe(500)
        return ["refund policy", "refund policy", ""]
      },
    })
    expect(expansionCalls).toBe(1)
    expect(expandedMatch[0]?.sourceId).toBe(source.id)

    const staleJob = await enqueueKnowledgeIndex(context, {
      sourceId: source.id,
      kind: "resync",
    })
    await database.execute(sql`update build_knowledge_jobs set
      status='running', attempts=0, lease_token='expired-owner',
      lease_expires_at=now()-interval '1 second',
      heartbeat_at=now()-interval '1 second'
      where project_id=${context.projectId} and id=${staleJob.id}`)
    await assert.rejects(
      heartbeatKnowledgeJob(context, {
        jobId: staleJob.id,
        leaseToken: "expired-owner",
      }),
      /lease/i
    )
    const recovered = await runKnowledgeJob(context, { jobId: staleJob.id })
    expect(recovered.status).toBe("succeeded")
    expect(recovered.attempts).toBe(1)
    await assert.rejects(
      heartbeatKnowledgeJob(context, {
        jobId: staleJob.id,
        leaseToken: "expired-owner",
      }),
      /lease/i
    )

    const grounded = await retrieveGroundedKnowledge(context, {
      agentId: agent.id,
      query: "refund",
    })
    const groundedResults = await retrieveKnowledge(context, {
      agentId: agent.id,
      query: "refund",
    })
    expect(grounded.context).toContain("Refund policy")
    expect(grounded.text).toContain("Refund policy")
    expect(grounded.documents[0]?.sourceId).toBe(source.id)
    expect(grounded.citations[0]?.chunkId).toBe(groundedResults[0]?.chunkId)

    const exported = await exportKnowledgeSource(context, {
      sourceId: source.id,
    })
    expect(exported.content).toContain("refund")

    const supersededJob = await enqueueKnowledgeIndex(context, {
      sourceId: source.id,
      kind: "resync",
    })
    await database.execute(sql`update build_knowledge_jobs set
      status='running', lease_token='superseded-owner',
      lease_expires_at=now()+interval '5 minutes', heartbeat_at=now()
      where project_id=${context.projectId} and id=${supersededJob.id}`)
    const failedUpdate = await updateKnowledgeSource(context, {
      sourceId: source.id,
      expectedRevision: 1,
      text: "",
    })
    expect(failedUpdate.revision).toBe(2)
    await assert.rejects(
      heartbeatKnowledgeJob(context, {
        jobId: supersededJob.id,
        leaseToken: "superseded-owner",
      }),
      /lease/i
    )
    expect(
      (await runKnowledgeJob(context, { jobId: supersededJob.id })).status
    ).toBe("cancelled")
    const failedJobs = await runQueuedKnowledgeJobs(context)
    expect(failedJobs[0].status).toBe("failed")
    expect(
      (await getKnowledgeSource(context, { sourceId: source.id })).status
    ).toBe("error")
    expect(
      (
        await retrieveKnowledge(context, {
          agentId: agent.id,
          query: "refund seven days",
        })
      )[0]?.content
    ).toContain("seven days")

    const updated = await updateKnowledgeSource(context, {
      sourceId: source.id,
      expectedRevision: 2,
      text: "Customers can request a refund within thirty days of purchase.",
    })
    expect(updated.revision).toBe(3)
    await runQueuedKnowledgeJobs(context)
    const nextResults = await retrieveKnowledge(context, {
      agentId: agent.id,
      query: "thirty days",
    })
    expect(nextResults[0]?.content).toContain("thirty days")

    await deleteKnowledgeSource(context, { sourceId: source.id })
    await assert.rejects(
      getKnowledgeSource(context, { sourceId: source.id }),
      /not found/i
    )
    expect(
      await retrieveKnowledge(context, { agentId: agent.id, query: "refund" })
    ).toEqual([])
    const biography = await createKnowledgeSource(context, {
      agentId: agent.id,
      name: "Team biography",
      kind: "text",
      text: "Mara Serrano é fundadora e atua em estratégia de produto e crescimento.",
    })
    await createKnowledgeSource(context, {
      agentId: agent.id,
      name: "Directory navigation",
      kind: "text",
      text: "De acordo com o site, qual é a informação e como a empresa ajuda? ".repeat(
        60
      ),
    })
    await runQueuedKnowledgeJobs(context)
    const naturalQuestion = await retrieveKnowledge(context, {
      agentId: agent.id,
      query:
        "Quem é Mara Serrano e qual é a especialidade dela de acordo com o site?",
    })
    expect(naturalQuestion[0]?.sourceId).toBe(biography.id)
  }
)
