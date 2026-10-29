import {
  assertPublicHttpUrl,
  publicHttpRequest,
  type PublicHttpResponse,
} from "@/src/server/build/http"
import {
  KNOWLEDGE_LIMITS,
  normalizeKnowledgeText,
  websiteSourceConfigSchema,
  type WebsiteSourceConfig,
} from "@/src/lib/build/knowledge"
import { extractHtmlText } from "./extract"

export type CrawledPage = {
  url: string
  title?: string
  text: string
  fetchedAt: string
  contentType: string
}

export type CrawlProgress = {
  discoveredPages: number
  indexedPages: number
  failedPages: number
}

export type CrawlCheckpoint = {
  requestUrl: string
  page: CrawledPage
  links: string[]
  bytes: number
}

export class KnowledgeCrawlError extends Error {
  readonly code = "KNOWLEDGE_CRAWL_FAILED"
}

/**
 * Validate a source URL before it is persisted or fetched. The shared HTTP
 * helper performs the DNS pinning and public-address check at request time;
 * this wrapper keeps the knowledge API's typed error and async contract.
 */
export async function assertPublicUrl(raw: string) {
  try {
    const url = assertPublicHttpUrl(raw)
    if (url.port && !new Set(["80", "443"]).has(url.port))
      throw new Error("Only ports 80 and 443 are allowed for public sources.")
    return url
  } catch (error) {
    throw new KnowledgeCrawlError(
      error instanceof Error
        ? error.message
        : "The source URL is not a safe public HTTP URL."
    )
  }
}

type PublicFetchResult = {
  url: URL
  contentType: string
  body: Uint8Array
}

/**
 * Fetch one public response without allowing the DNS validation/fetch
 * time-of-check gap. Redirects are intentionally handled one hop at a time so
 * every target is validated and site constrained through the shared
 * pinned request helper.
 */
async function fetchPublic(
  rawUrl: string,
  options: {
    timeoutMs?: number
    maxBytes?: number
    redirectDepth?: number
    visited?: ReadonlySet<string>
    preferMarkdown?: boolean
  } = {}
): Promise<PublicFetchResult | null> {
  const url = await assertPublicUrl(rawUrl)
  if (options.visited?.has(url.href)) return null
  let response: PublicHttpResponse
  try {
    response = await publicHttpRequest(url.toString(), {
      timeoutMs: options.timeoutMs ?? 20_000,
      maxResponseBytes:
        options.maxBytes ?? KNOWLEDGE_LIMITS.maxCrawlBytesPerPage,
      headers: {
        accept: options.preferMarkdown
          ? "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1"
          : "application/xml, text/xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
        "user-agent": "Datool-KnowledgeBot/1.0",
      },
    })
  } catch (error) {
    throw new KnowledgeCrawlError(
      error instanceof Error ? error.message : "The source request failed."
    )
  }

  if (response.status >= 300 && response.status < 400) {
    if ((options.redirectDepth ?? 0) >= 3)
      throw new KnowledgeCrawlError("The source followed too many redirects.")
    const location = response.headers.get("location")
    if (!location)
      throw new KnowledgeCrawlError(
        `The source returned redirect ${response.status} without a location.`
      )
    const redirectTarget = await assertPublicUrl(
      new URL(location, url).toString()
    )
    if (!sameCrawlSite(url, redirectTarget))
      throw new KnowledgeCrawlError(
        "The source redirects outside its website. Use the destination website URL instead."
      )
    return fetchPublic(redirectTarget.toString(), {
      ...options,
      redirectDepth: (options.redirectDepth ?? 0) + 1,
    })
  }
  if (response.status < 200 || response.status >= 300)
    throw new KnowledgeCrawlError(
      `The source returned HTTP ${response.status}.`
    )

  return {
    url: new URL(response.url),
    contentType: (response.headers.get("content-type") ?? "text/plain")
      .split(";", 1)[0]
      .toLowerCase(),
    body: response.body,
  }
}

function sameOrigin(a: URL, b: URL) {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    (a.port || (a.protocol === "https:" ? "443" : "80")) ===
      (b.port || (b.protocol === "https:" ? "443" : "80"))
  )
}

/** Only permit the conventional www alias and HTTP-to-HTTPS upgrade. Every
 * request still resolves and pins a public address in publicHttpRequest. */
function sameCrawlSite(a: URL, b: URL) {
  if (sameOrigin(a, b)) return true
  return (
    !a.port &&
    !b.port &&
    a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "") &&
    (a.protocol === b.protocol ||
      (a.protocol === "http:" && b.protocol === "https:"))
  )
}

function matchesExclude(url: string, pattern: string | undefined) {
  if (!pattern) return false
  const normalizedPattern = pattern.trim()
  if (!normalizedPattern) return false
  // Support a safe, predictable * wildcard without evaluating user regexes.
  const parts = normalizedPattern.split("*")
  if (parts.length === 1) return url.includes(parts[0])
  let offset = 0
  for (const part of parts) {
    if (!part) continue
    const found = url.indexOf(part, offset)
    if (found < 0) return false
    offset = found + part.length
  }
  return true
}

function sitemapUrls(xml: string) {
  return [...xml.matchAll(/<loc\s*>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((match) => match[1].replace(/&amp;/gi, "&").trim())
    .filter(Boolean)
}

export async function crawlKnowledgeSource(options: {
  kind: "website" | "sitemap"
  url: string
  config?: Partial<WebsiteSourceConfig>
  onProgress?: (progress: CrawlProgress) => Promise<void>
  checkpoints?: CrawlCheckpoint[]
  onPage?: (checkpoint: CrawlCheckpoint) => Promise<void>
}) {
  const config = websiteSourceConfigSchema.parse(options.config ?? {})
  const root = await assertPublicUrl(options.url)
  const urls = new Set<string>()
  const sitemaps = new Set<string>()
  const failures: Array<{ url: string; error: string }> = []
  let truncated = false
  let totalBytes = 0
  let textCharacters = 0
  const pages: CrawledPage[] = []
  const fetched = new Set<string>()

  function candidate(raw: string, base: URL): URL | null {
    try {
      const url = new URL(raw.replace(/&amp;/gi, "&"), base)
      url.hash = ""
      if (
        !sameCrawlSite(root, url) ||
        matchesExclude(url.href, config.excludePattern)
      )
        return null
      if (
        /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|mp[34]|woff2?|css|js)$/i.test(
          url.pathname
        )
      )
        return null
      // Tracking links must not cause repeated crawling of the same page.
      for (const key of [...url.searchParams.keys()])
        if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
      return url
    } catch {
      return null
    }
  }
  function enqueue(raw: string, base: URL) {
    const url = candidate(raw, base)
    if (!url || urls.has(url.href)) return
    if (urls.size >= KNOWLEDGE_LIMITS.maxCrawlDiscoveredUrls) {
      truncated = true
      return
    }
    urls.add(url.href)
  }
  const progress = () =>
    options.onProgress?.({
      discoveredPages: urls.size,
      indexedPages: pages.length,
      failedPages: failures.length,
    })
  async function read(raw: string, visited?: ReadonlySet<string>) {
    await progress()
    let response: PublicFetchResult | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchPublic(raw, {
          visited,
          preferMarkdown: Boolean(visited),
        })
        break
      } catch (error) {
        const transient =
          error instanceof KnowledgeCrawlError &&
          /timed out|request failed|HTTP (?:429|5\d\d)/i.test(error.message)
        if (!transient || attempt === 2) throw error
        await new Promise((resolve) =>
          setTimeout(resolve, 1_000 * (attempt + 1))
        )
        await progress()
      }
    }
    if (!response) return null
    totalBytes += response.body.byteLength
    if (totalBytes > KNOWLEDGE_LIMITS.maxCrawlTotalBytes)
      throw new KnowledgeCrawlError(
        "The website exceeds the crawl byte limit. Narrow the source scope."
      )
    return response
  }
  async function discoverSitemap(raw: string, required = false) {
    const url = candidate(raw, root)
    if (!url || sitemaps.has(url.href)) return
    if (sitemaps.size >= 100) {
      truncated = true
      return
    }
    sitemaps.add(url.href)
    let response: PublicFetchResult | null
    try {
      response = await read(url.href)
    } catch (error) {
      if (
        !(error instanceof KnowledgeCrawlError) ||
        required ||
        totalBytes > KNOWLEDGE_LIMITS.maxCrawlTotalBytes
      )
        throw error
      return // Sites without a sitemap are discovered through their page links.
    }
    if (!response) return
    const xml = new TextDecoder().decode(response.body)
    const index = /<sitemapindex(?:\s|>)/i.test(xml)
    for (const value of sitemapUrls(xml)) {
      if (index) {
        const nested = candidate(value, response.url)
        if (nested) await discoverSitemap(nested.href, true)
      } else enqueue(value, response.url)
    }
  }
  for (const checkpoint of options.checkpoints ?? []) {
    const url = candidate(checkpoint.requestUrl, root)
    const canonical = candidate(checkpoint.page.url, root)
    if (!url || !canonical) continue
    enqueue(url.href, root)
    if (!fetched.has(canonical.href)) {
      pages.push(checkpoint.page)
      textCharacters += checkpoint.page.text.length
    }
    totalBytes += checkpoint.bytes
    fetched.add(url.href)
    fetched.add(canonical.href)
    for (const link of checkpoint.links) enqueue(link, canonical)
  }
  if (options.kind === "sitemap") await discoverSitemap(root.href, true)
  else {
    enqueue(root.href, root)
    if (config.followSitemap)
      await discoverSitemap(new URL("/sitemap.xml", root).href)
  }

  async function crawlPage(rawUrl: string) {
    if (fetched.has(rawUrl)) return
    let response: PublicFetchResult | null
    try {
      response = await read(rawUrl, fetched)
    } catch (error) {
      if (
        !(error instanceof KnowledgeCrawlError) ||
        totalBytes > KNOWLEDGE_LIMITS.maxCrawlTotalBytes
      )
        throw error
      failures.push({
        url: rawUrl,
        error: error instanceof Error ? error.message : "Request failed.",
      })
      await progress()
      return
    }
    if (!response) return
    if (fetched.has(response.url.href)) return
    fetched.add(rawUrl)
    fetched.add(response.url.href)
    const content = new TextDecoder().decode(response.body)
    const links: string[] = []
    if (options.kind === "website" && response.contentType.includes("html")) {
      for (const match of content.matchAll(
        /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
      )) {
        const link = candidate(match[1] ?? match[2], response.url)
        if (link) {
          links.push(link.href)
          enqueue(link.href, response.url)
        }
      }
    }
    if (
      options.kind === "website" &&
      response.contentType.includes("markdown")
    ) {
      for (const match of content.matchAll(
        /(?<!!)\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g
      )) {
        const link = candidate(match[1], response.url)
        if (link) {
          links.push(link.href)
          enqueue(link.href, response.url)
        }
      }
    }
    if (!/(?:html|plain|markdown)/.test(response.contentType)) return
    const parsed: { text: string; title?: string } =
      response.contentType.includes("html")
        ? extractHtmlText(content)
        : { text: normalizeKnowledgeText(content) }
    if (!parsed.text) return
    textCharacters += parsed.text.length
    if (textCharacters > KNOWLEDGE_LIMITS.maxCrawlTextCharacters)
      throw new KnowledgeCrawlError(
        "The website exceeds the extracted text limit. Narrow the source scope."
      )
    const page = {
      url: response.url.href,
      title: parsed.title,
      text: parsed.text,
      fetchedAt: new Date().toISOString(),
      contentType: response.contentType,
    }
    await options.onPage?.({
      requestUrl: rawUrl,
      page,
      links,
      bytes: response.body.byteLength,
    })
    pages.push(page)
    await progress()
  }
  // Small paced batches keep large imports practical without flooding a host.
  // Newly discovered links are appended to the same breadth-first queue.
  let cursor = 0
  while (cursor < urls.size && pages.length < config.maxPages) {
    const batch = [...urls].slice(
      cursor,
      cursor +
        Math.min(
          KNOWLEDGE_LIMITS.maxCrawlConcurrency,
          config.maxPages - pages.length
        )
    )
    cursor += batch.length
    const results = await Promise.allSettled(
      batch.map(async (rawUrl, index) => {
        if (config.pacingMs > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, config.pacingMs * (index + 1))
          )
        await crawlPage(rawUrl)
      })
    )
    for (const result of results)
      if (result.status === "rejected") throw result.reason
  }
  if (cursor < urls.size) truncated = true
  pages.sort((a, b) => a.url.localeCompare(b.url))
  if (!pages.length)
    throw new KnowledgeCrawlError(
      failures.length
        ? `Could not read any pages. ${failures[0].error}`
        : "The crawl produced no extractable pages."
    )
  return {
    pages,
    summary: {
      discoveredPages: urls.size,
      indexedPages: pages.length,
      failedPages: failures.length,
      failures: failures.slice(0, 100),
      truncated,
    },
  }
}
