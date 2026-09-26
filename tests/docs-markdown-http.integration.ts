import assert from "node:assert/strict"
import { readdirSync } from "node:fs"

// Read-only checks against a built docs server; no project credentials needed.
const base = process.env.DOCS_TEST_URL
assert(base, "Set DOCS_TEST_URL to the running docs origin.")
const pages = readdirSync("content/docs", { recursive: true })
  .filter(
    (path): path is string => typeof path === "string" && path.endsWith(".mdx")
  )
  .map((path) =>
    `/docs/${path.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "")}`.replace(
      /\/$/,
      ""
    )
  )

function variesByAccept(response: Response) {
  return response.headers
    .get("vary")
    ?.toLowerCase()
    .split(/,\s*/)
    .includes("accept")
}

async function request(path: string, accept: string, method = "GET") {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { Accept: accept },
    redirect: "error",
  })
  return { response, body: await response.text() }
}

for (const path of pages) {
  const html = await request(path, "text/html")
  assert.equal(html.response.status, 200, path)
  const button = html.body.match(
    /<a\b[^>]*aria-label="View as Markdown"[^>]*>/
  )?.[0]
  assert.ok(button?.includes(`href="${path}.md"`), `${path}: Markdown button`)
  const alternate = html.body.match(/<link\b[^>]*type="text\/markdown"[^>]*>/)?.[0]
  assert.ok(alternate?.includes(`href="${path}.md"`), `${path}: Markdown metadata`)
  const markdown = await request(`${path}.md`, "text/markdown")
  assert.equal(markdown.response.status, 200, path)
  for (const [url, accept] of [
    [path, "text/markdown"],
    [`${path}.md`, "text/html"],
  ]) {
    const { response, body } = await request(url, accept)
    assert.equal(response.status, 200, url)
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/markdown\b/,
      url
    )
    assert.equal(body, markdown.body, url)
    assert.ok(variesByAccept(response), `${url}: missing Vary: Accept`)
    const head = await request(url, accept, "HEAD")
    assert.equal(head.response.status, 200, url)
    assert.equal(head.body, "", url)
    assert.equal(
      head.response.headers.get("content-type"),
      response.headers.get("content-type"),
      url
    )
  }
  const removed = path.replace(/^\/docs/, "/docs/markdown")
  for (const accept of ["text/html", "text/markdown"]) {
    for (const method of ["GET", "HEAD"]) {
      const { response } = await request(removed, accept, method)
      assert.equal(response.status, 404, `${removed}: ${method} ${accept}`)
      assert.equal(response.headers.get("location"), null, removed)
    }
  }
}

const llms = await request("/llms.txt", "text/plain")
assert.equal(llms.response.status, 200)
assert.ok(!llms.body.includes("/docs/markdown"))
const markdownLinks = [...llms.body.matchAll(/\]\((https?:\/\/[^)]+)\)/g)]
  .map((match) => new URL(match[1]).pathname)
  .filter((path) => path === "/docs.md" || path.startsWith("/docs/"))
assert.deepEqual(markdownLinks.sort(), pages.map((path) => `${path}.md`).sort())

const path = "/docs/evaluation/datasets"
for (const accept of [
  "text/html",
  "*/*",
  "text/markdown;q=0, text/html",
  "text/markdown;q=0.2, text/html;q=0.8",
]) {
  const { response, body } = await request(path, accept)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/)
  assert.match(body, /<!doctype html>/i)
  assert.ok(
    variesByAccept(response) ||
      /no-store/.test(response.headers.get("cache-control") ?? ""),
    "HTML must vary by Accept or disable caching to avoid serving it to Markdown clients"
  )
}

for (const [path, accept] of [
  ["/docs/missing-markdown-page", "text/markdown"],
  ["/docs/missing-markdown-page.md", "text/html"],
  ["/docs/markdown/missing-markdown-page", "text/markdown"],
]) {
  for (const method of ["GET", "HEAD"]) {
    const { response, body } = await request(path, accept, method)
    assert.equal(response.status, 404, path)
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/markdown\b/
    )
    assert.ok(variesByAccept(response))
    if (method === "GET") assert.match(body, /^# Page not found/)
    else assert.equal(body, "")
  }
}

const tabs = await request("/docs/get-started/first-trace.md", "*/*")
for (const label of [
  "AI SDK 7 — trace a model call",
  "TypeScript — trace an OpenAI call",
  "Python — trace a function with a decorator",
  "LangGraph — attach a callback to your graph",
]) {
  assert.ok(tabs.body.includes(label), label)
}
assert.ok(!tabs.body.includes("<Tab"))
console.log(
  `PASS ${pages.length} docs: negotiated Markdown, .md URLs and discovery links, removed URLs return 404, GET/HEAD, HTML preference, cache separation, and tab contents.`
)
