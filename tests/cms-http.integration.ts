import assert from "node:assert/strict"
import nextEnv from "@next/env"
import {
  productFeatures,
  productPillars,
  productFeatureHref,
} from "../lib/marketing/product"

nextEnv.loadEnvConfig(process.cwd())
const base = process.env.CMS_TEST_URL || process.env.BETTER_AUTH_URL
if (
  !base ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
) {
  throw new Error("CMS HTTP checks require a running, seeded local preview.")
}

for (const [path, expected] of [
  ["/", 200],
  ["/landing-page", 200],
  ["/faq", 200],
  ["/faq/what-is-datool", 200],
  ["/faq/unknown-cms-test-question", 404],
  ["/pages/how-it-works", 200],
  ["/pages/draft-example", 404],
  ["/pages/unknown-cms-test-page", 404],
  ["/sign-in", 200],
  ["/product", 200],
  ["/pricing", 200],
  ["/product/unknown-cms-test-feature", 404],
] as const) {
  const response: Response = await fetch(new URL(path, base))
  assert.equal(response.status, expected, path)
  const body = await response.text()
  assert.ok(!body.includes("This is a draft"), `${path}: leaked draft content`)
  console.log(`${path}: ${response.status}`)
  if (path === "/") {
    assert.equal(response.redirected, false)
    assert.ok(body.includes("See what your AI is doing."))
    assert.ok(!body.includes("NEXT_REDIRECT"))
  }
  if (path === "/" || path === "/landing-page") {
    const canonical = new URL("/", base).href
    assert.ok(body.includes(`rel="canonical" href="${canonical}"`))
    assert.ok(body.includes(`property="og:url" content="${canonical}"`))
    assert.ok(!body.includes('href="/landing-page"'))
  }
  if (path === "/faq") assert.ok(body.includes('href="/faq/what-is-datool"'))
  if (path === "/faq/what-is-datool") {
    assert.ok(body.includes("Related questions"))
    assert.ok(body.includes('href="/faq/what-can-i-evaluate"'))
    assert.ok(body.includes("Related pages"))
    assert.ok(body.includes('href="/"'))
    assert.ok(!body.includes('href="/landing-page"'))
    assert.ok(
      body.includes('rel="canonical" href="' + new URL(path, base).href + '"')
    )
    const json = body.match(
      /<script type="application\/ld\+json">(.*?)<\/script>/s
    )
    assert.ok(json)
    assert.equal(JSON.parse(json[1])["@type"], "FAQPage")
  }
}
const sitemap = await fetch(new URL("/sitemap.xml", base))
assert.equal(sitemap.status, 200)
const sitemapBody = await sitemap.text()
assert.ok(sitemapBody.includes(`<loc>${new URL("/", base).href}</loc>`))
assert.ok(!sitemapBody.includes("/landing-page"))
for (const feature of productPillars) {
  const path = `/product/${feature.slug}`
  const canonical: string = new URL(path, base).href
  const response: Response = await fetch(canonical)
  assert.equal(response.status, 200, path)
  const html = await response.text()
  assert.ok(html.includes(`rel="canonical" href="${canonical}"`), path)
  assert.ok(html.includes(`href="${feature.docs}"`), `${path}: docs link`)
  for (const item of productFeatures.filter(
    (item) => item.group === feature.name
  )) {
    assert.ok(
      html.includes(`id="${item.slug}"`),
      `${path}: ${item.slug} section`
    )
    assert.ok(
      html.includes(`href="${item.docs}"`),
      `${path}: ${item.slug} documentation`
    )
  }
  assert.ok(sitemapBody.includes(`<loc>${canonical}</loc>`), `${path}: sitemap`)
  const alias: Response = await fetch(
    new URL(`/pages/product-${feature.slug}`, base),
    {
      redirect: "manual",
    }
  )
  assert.equal(alias.status, 308, `${path}: canonical redirect`)
  assert.equal(new URL(alias.headers.get("location")!, base).pathname, path)
  const markdown = await fetch(`${canonical}.md`, {
    headers: { Accept: "text/markdown" },
  })
  assert.equal(markdown.status, 200, `${path}: markdown`)
  assert.equal(markdown.headers.get("link"), `<${canonical}>; rel="canonical"`)
  assert.ok((await markdown.text()).includes("# "), `${path}: markdown content`)
  console.log(
    `${path}: HTML, canonical redirect, Markdown, docs link, sitemap passed`
  )
}
for (const feature of productFeatures) {
  for (const path of [
    `/product/${feature.slug}`,
    `/pages/product-${feature.slug}`,
  ]) {
    const response: Response = await fetch(new URL(path, base), {
      redirect: "manual",
    })
    assert.equal(response.status, 308, path)
    assert.equal(
      response.headers.get("location"),
      productFeatureHref(feature),
      path
    )
  }
  assert.ok(
    !sitemapBody.includes(
      `<loc>${new URL(`/product/${feature.slug}`, base).href}</loc>`
    )
  )
}
assert.equal((sitemapBody.match(/<loc>[^<]*\/product\//g) || []).length, 4)
console.log(
  "Four product pages indexed; legacy feature routes redirect to their sections."
)
for (const path of [
  "/landing-page.md",
  "/pages/how-it-works.md",
  "/faq.md",
  "/faq/what-is-datool.md",
]) {
  const response: Response = await fetch(new URL(path, base), {
    headers: { Accept: "text/markdown" },
  })
  assert.equal(response.status, 200, path)
  assert.equal(
    response.headers.get("content-type"),
    "text/markdown; charset=utf-8"
  )
  assert.equal(
    response.headers.get("link"),
    `<${new URL(path === "/landing-page.md" ? "/" : path.slice(0, -3), base).href}>; rel="canonical"`
  )
  const markdown = await response.text()
  assert.match(markdown, /^# /m)
  assert.ok(!markdown.includes("<!DOCTYPE html>"))
  if (path === "/landing-page.md") {
    assert.ok(markdown.includes("### What is Datool?"))
    assert.ok(markdown.includes("[Open Datool](/sign-in)"))
  }
  const head: Response = await fetch(new URL(path, base), {
    method: "HEAD",
    headers: { Accept: "text/markdown" },
  })
  assert.equal(head.status, 200)
  assert.equal(
    head.headers.get("content-type"),
    response.headers.get("content-type")
  )
  assert.equal(await head.text(), "")
  const browserResponse: Response = await fetch(new URL(path, base), {
    headers: { Accept: "text/html,application/xhtml+xml" },
  })
  assert.equal(
    browserResponse.headers.get("content-type"),
    "text/plain; charset=utf-8"
  )
  assert.equal(await browserResponse.text(), markdown)
  console.log(`${path}: Markdown GET and HEAD passed`)
}
for (const path of [
  "/pages/draft-example.md",
  "/pages/unknown-cms-test-page.md",
  "/faq/unknown-cms-test-question.md",
]) {
  const response: Response = await fetch(new URL(path, base))
  assert.equal(response.status, 404, path)
  assert.equal(await response.text(), "Not found\n")
}
const pages = await (
  await fetch(new URL("/cms/api/pages?draft=true", base))
).json()
assert.ok(Array.isArray(pages.docs))
assert.ok(
  pages.docs.every(
    (doc: { _status: string; slug: string }) =>
      doc._status === "published" && doc.slug !== "draft-example"
  )
)
const denied = await fetch(new URL("/cms/api/pages", base), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "Unauthorized",
    slug: "unauthorized-http-test",
    layout: [],
  }),
})
assert.equal(denied.status, 403)
const preview = await fetch(new URL("/cms-preview?type=pages", base), {
  redirect: "manual",
})
const previewBody = await preview.text()
assert.ok(
  preview.headers.get("location")?.includes("/cms/login") ||
    previewBody.includes("/cms/login")
)
const workspace = await fetch(new URL("/projects", base), {
  redirect: "manual",
})
const workspaceBody = await workspace.text()
// The existing workspace loading boundary streams its auth redirect.
assert.ok(
  workspace.headers.get("location")?.includes("/sign-in") ||
    workspaceBody.includes("NEXT_REDIRECT;replace;/sign-in")
)
console.log(
  "Anonymous REST draft isolation, write denial, preview protection, and existing workspace redirect passed."
)
