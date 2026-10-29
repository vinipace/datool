import { afterEach, expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import * as publicHttp from "@/src/server/build/http"
import {
  crawlKnowledgeSource,
  type CrawlCheckpoint,
  type CrawlProgress,
} from "@/src/server/build/knowledge/crawler"

afterEach(() => fetchSpy?.mockRestore())
let fetchSpy: { mockRestore(): void } | undefined

function response(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  status = 200
) {
  return {
    url,
    status,
    headers: new Headers({ "content-type": "text/html", ...headers }),
    body: new TextEncoder().encode(body),
  }
}

for (const [origin, canonical] of [
  ["https://example.test", "https://www.example.test"],
  ["https://www.example.test", "https://example.test"],
  ["http://example.test", "https://www.example.test"],
])
  test(`crawls canonical redirects and discovers canonical sitemap pages: ${origin}`, async () => {
    const progress: CrawlProgress[] = []
    const checkpoints: CrawlCheckpoint[] = []
    const requests: string[] = []
    fetchSpy = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
      async (raw) => {
        requests.push(raw)
        const url = new URL(raw)
        if (url.origin === origin)
          return response(
            raw,
            "",
            { location: `${canonical}${url.pathname}` },
            308
          )
        if (url.pathname === "/sitemap.xml")
          return response(
            raw,
            `<urlset><url><loc>${canonical}/help</loc></url></urlset>`,
            { "content-type": "application/xml" }
          )
        return response(
          raw,
          `<h1>Documentation</h1><p>Useful content.</p><a href="${canonical}/linked">Read more</a><a href="https://other.test/private">External</a>`
        )
      }
    )
    const result = await crawlKnowledgeSource({
      kind: "website",
      url: origin,
      config: { pacingMs: 0 },
      onProgress: async (value) => {
        progress.push(value)
      },
      onPage: async (value) => {
        checkpoints.push(value)
      },
    })
    expect(result.pages.map((page) => page.url)).toEqual([
      `${canonical}/`,
      `${canonical}/help`,
      `${canonical}/linked`,
    ])
    expect(result.summary.failedPages).toBe(0)
    expect(progress.at(-1)?.indexedPages).toBe(3)
    expect(progress.some((value) => value.indexedPages === 1)).toBe(true)

    requests.length = 0
    const resumed = await crawlKnowledgeSource({
      kind: "website",
      url: origin,
      config: { pacingMs: 0, followSitemap: false },
      checkpoints,
    })
    expect(resumed.pages).toEqual(result.pages)
    expect(requests.length).toBe(0)
  })

for (const [location, cause] of [
  ["https://other.test/", /outside its website/],
  ["https://api.example.test/", /outside its website/],
  ["https://example.test.evil.test/", /outside its website/],
  ["http://www.example.test/", /outside its website/],
  ["https://www.example.test:8443/", /ports 80 and 443/],
  ["http://127.0.0.1/", /public internet address/],
  ["https://user:password@www.example.test/", /without embedded credentials/],
] as const)
  test(`rejects unsafe redirect ${location} and preserves the cause`, async () => {
    let requests = 0
    fetchSpy = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
      async (url) => {
        requests++
        return response(url, "", { location }, 302)
      }
    )
    await assert.rejects(
      crawlKnowledgeSource({
        kind: "website",
        url: "https://example.test",
        config: { pacingMs: 0, followSitemap: false },
      }),
      cause
    )
    expect(requests).toBe(1)
  })

test("preserves HTTP failures instead of reporting empty extraction", async () => {
  fetchSpy = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
    async (url) => response(url, "", {}, 403)
  )
  await assert.rejects(
    crawlKnowledgeSource({
      kind: "website",
      url: "https://example.test",
      config: { pacingMs: 0, followSitemap: false },
    }),
    /Could not read any pages. The source returned HTTP 403./
  )
})
